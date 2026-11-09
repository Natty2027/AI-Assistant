/**
 * Ties the assistant to a real person: their publishing connections, their website folder,
 * their photos, their proposals, and the executors that can carry an approved action out today
 * (publishing a site to Netlify; posting to Bluesky, X, a Facebook Page or Instagram).
 *
 * The database access and network are passed in, so the same code runs against Postgres and
 * Netlify in production and against PGlite and a fake Netlify in tests.
 */
import { createHash } from "node:crypto";
import { ActionError, ActionStore, type ExecutionResult, type Proposal } from "./approvals.ts";
import { ACTIONS, isPlatform, type ActionKind, type Context, type Platform } from "./policy.ts";
import { SiteSandbox } from "./sandbox.ts";
import { runAgent, type AgentDeps, type AgentMode, type AgentResult } from "./loop.ts";
import { ScheduleSnapshot } from "./schedule.ts";
import { MemoryStore } from "./memory.ts";
import { publish, verifyToken } from "./netlify.ts";
import { parseCredential, publishPost, verifyCredential, type BlueskyCredential } from "./bluesky.ts";
import * as x from "./x.ts";
import * as meta from "./meta.ts";
import { MediaError, MediaStore } from "./media.ts";
import { appReturnUrl, OAuthStates, redirectUri, type OAuthProvider } from "./oauth.ts";
import type { OAuthClient } from "../config.ts";
import { ProviderError, type FetchLike, type Run } from "../shared.ts";
import { decryptToken, encryptToken, newDataKeyId } from "../crypto/envelope.ts";

/** What can actually be carried out today. Approving anything else is refused up front, so
 *  nobody approves something that has nowhere to go. A social post can only target a connected
 *  account, and Bluesky is the only social connection that can be made, so it is covered. */
export const EXECUTABLE: ReadonlySet<ActionKind> = new Set<ActionKind>(["site.deploy", "social.post"]);

/** Which platform each social provider posts to. */
const SOCIAL_PROVIDERS: Record<string, Platform> = { bluesky: "bluesky", x: "x", facebook: "facebook", instagram: "instagram" };

const PROVIDER_NAMES: Record<string, string> = { bluesky: "Bluesky", x: "X", facebook: "Facebook", instagram: "Instagram" };

export interface ServiceDeps {
  run: Run;
  fetch: FetchLike;
  sitesDir: string;
  /** null when no AI key is configured: everything except running the assistant still works. */
  client: AgentDeps["client"] | null;
  store?: ActionStore;
  sleep?: (ms: number) => Promise<void>;
  /** Where attached photos are kept (see media.ts). */
  mediaDir: string;
  /** Sign-in with X and Meta. Each is off until this server's public address and that
   *  platform's developer app are configured. */
  oauth?: { publicUrl?: string; x?: OAuthClient; meta?: OAuthClient };
}

export interface ConnectionView { id: string; kind: string; provider: string; platform: Platform | null; label: string; publishesTo: string | null }

export interface ProposalView {
  id: string; kind: ActionKind; label: string; summary: string;
  payload: Readonly<Record<string, unknown>>; payloadHash: string;
  checks: Proposal["checks"]; tainted: boolean; status: Proposal["status"];
  expiresAt: string; result: Proposal["result"] | null; canBeCarriedOut: boolean;
}

export function viewOf(p: Proposal): ProposalView {
  return {
    id: p.id, kind: p.kind, label: ACTIONS[p.kind].label, summary: p.summary,
    payload: p.payload, payloadHash: p.payloadHash, checks: p.checks, tainted: p.tainted,
    status: p.status, expiresAt: p.expiresAt.toISOString(), result: p.result ?? null,
    canBeCarriedOut: EXECUTABLE.has(p.kind),
  };
}

export class AgentService {
  readonly store: ActionStore;
  readonly media: MediaStore;
  readonly memory: MemoryStore;
  private readonly oauthStates = new OAuthStates();

  constructor(private readonly d: ServiceDeps) {
    this.store = d.store ?? new ActionStore();
    this.media = new MediaStore(d.mediaDir);
    this.memory = new MemoryStore(d.run);
  }

  /** Server-derived, never user- or model-supplied. */
  siteIdFor(userId: string): string {
    return `u-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
  }

  sandbox(userId: string): Promise<SiteSandbox> {
    return SiteSandbox.open(this.d.sitesDir, this.siteIdFor(userId));
  }

  /** Account deletion: the person's website files, photos, proposals and unfinished sign-ins.
   *  Connections live in the database and are deleted with the rest of their rows. */
  async forget(userId: string): Promise<void> {
    this.store.forget(userId);
    this.oauthStates.forget(userId);
    this.memory.forgetAll(userId);
    await SiteSandbox.remove(this.d.sitesDir, this.siteIdFor(userId));
    await this.media.removeAll(this.siteIdFor(userId));
  }

  /* ---------------- photos ---------------- */

  async savePhoto(userId: string, base64: unknown): Promise<string> {
    try {
      return await this.media.save(this.siteIdFor(userId), base64);
    } catch (e) {
      if (e instanceof MediaError) throw new ActionError("bad_media", e.message);
      throw e;
    }
  }

  /** The public address Meta downloads a photo from. */
  private photoUrl(id: string): string | null {
    return this.d.oauth?.publicUrl ? `${this.d.oauth.publicUrl}/media/${id}.jpg` : null;
  }

  /* ---------------- connections ---------------- */

  async connections(userId: string): Promise<ConnectionView[]> {
    const { rows } = await this.d.run(
      `select id, kind, provider, label, target_ref from action_connections
        where user_id = $1 and revoked_at is null order by created_at`, [userId]);
    return rows.map((r) => ({
      id: r.id, kind: r.kind, provider: r.provider, platform: SOCIAL_PROVIDERS[r.provider] ?? null,
      label: r.label, publishesTo: r.kind === "hosting" ? r.target_ref ?? null : null,
    }));
  }

  /** Checks the token with Netlify before storing it, so a typo fails now, not at publish time. */
  async connectNetlify(userId: string, token: unknown): Promise<ConnectionView> {
    if (typeof token !== "string" || token.length < 20 || token.length > 300 || /\s/.test(token)) {
      throw new ActionError("bad_token", "That doesn't look like a Netlify personal access token.");
    }
    let label: string;
    try {
      label = (await verifyToken(token, this.d.fetch)).label;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "unauthorized") throw new ActionError("bad_token", "Netlify didn't accept that token.");
      throw new ActionError("provider_unavailable", "Couldn't reach Netlify to check the token. Try again shortly.");
    }
    const keyId = newDataKeyId();
    const { rows } = await this.d.run(
      `insert into action_connections (user_id, kind, provider, label, token_ct, data_key_id)
       values ($1, 'hosting', 'netlify', $2, $3, $4) returning id`,
      [userId, label, encryptToken(token, keyId), keyId]);
    return { id: rows[0].id, kind: "hosting", provider: "netlify", platform: null, label, publishesTo: null };
  }

  /** Checks the app password with Bluesky before storing it, so a typo fails now, not at post time. */
  async connectBluesky(userId: string, identifier: unknown, appPassword: unknown): Promise<ConnectionView> {
    let cred: BlueskyCredential;
    let verified: { label: string; handle: string };
    try {
      cred = parseCredential(identifier, appPassword);
      verified = await verifyCredential(cred, this.d.fetch);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "rejected") throw new ActionError("bad_token", e.message);
      if (e instanceof ProviderError && e.kind === "unauthorized") throw new ActionError("bad_token", "Bluesky didn't accept that handle and app password.");
      throw new ActionError("provider_unavailable", "Couldn't reach Bluesky to check the app password. Try again shortly.");
    }
    const keyId = newDataKeyId();
    const { rows } = await this.d.run(
      `insert into action_connections (user_id, kind, provider, label, token_ct, data_key_id, target_ref)
       values ($1, 'social', 'bluesky', $2, $3, $4, $5) returning id`,
      [userId, verified.label, encryptToken(JSON.stringify(cred), keyId), keyId, verified.handle]);
    return { id: rows[0].id, kind: "social", provider: "bluesky", platform: "bluesky", label: verified.label, publishesTo: null };
  }

  /* ---------------- sign-in with X and Meta ---------------- */

  /** Which sign-ins this server can offer, for the app. */
  oauthAvailable(): Record<OAuthProvider, boolean> {
    const o = this.d.oauth;
    return { x: Boolean(o?.publicUrl && o.x), meta: Boolean(o?.publicUrl && o.meta) };
  }

  /** The platform's sign-in page for this person; the app opens it in a secure browser sheet. */
  beginOAuth(userId: string, provider: OAuthProvider): string {
    const o = this.d.oauth;
    const client = o?.[provider];
    if (!o?.publicUrl || !client) {
      throw new ActionError("provider_unavailable", `Connecting ${provider === "x" ? "X" : "Facebook and Instagram"} isn't set up on this server yet.`);
    }
    const { state, challenge } = this.oauthStates.begin(userId, provider);
    const back = redirectUri(o.publicUrl, provider);
    return provider === "x" ? x.authorizeUrl(client, back, state, challenge) : meta.authorizeUrl(client, back, state);
  }

  /**
   * The platform sent the browser back. Returns where to send it next (the app's hera:// address,
   * with the outcome) and whose sign-in it was, so the caller can make sure their settings row
   * exists first. Never throws: every failure becomes a message the app shows.
   */
  async finishOAuth(
    provider: OAuthProvider, query: URLSearchParams, beforeSave: (userId: string) => Promise<void> = async () => {},
  ): Promise<string> {
    const fail = (message: string) => appReturnUrl(provider, { ok: false, message });
    const pending = this.oauthStates.finish(query.get("state") ?? "", provider);
    if (!pending) return fail("That sign-in expired. Please try connecting again.");
    // The person pressed Cancel or declined the permissions on the platform's page.
    if (query.get("error")) return fail("Connecting was cancelled.");
    const code = query.get("code");
    const o = this.d.oauth;
    const client = o?.[provider];
    if (!code || !o?.publicUrl || !client) return fail("Something went wrong signing in. Please try again.");
    const back = redirectUri(o.publicUrl, provider);
    try {
      await beforeSave(pending.userId);
      if (provider === "x") {
        await this.saveX(pending.userId, await x.exchangeCode(client, code, pending.verifier, back, this.d.fetch));
      } else {
        const pages = await meta.exchangeCode(client, code, back, this.d.fetch);
        if (!pages.length) {
          return fail("No Facebook Page was shared. Hera posts to Pages (not personal profiles) and to Instagram business or creator accounts linked to a Page. Create or pick a Page, then connect again.");
        }
        await this.saveMeta(pending.userId, pages);
      }
      return appReturnUrl(provider, { ok: true });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "unauthorized") return fail("The sign-in wasn't accepted. Please try again.");
      if (e instanceof ProviderError) return fail("Couldn't finish connecting right now. Try again shortly.");
      console.error(`[oauth] ${provider} sign-in failed`, e instanceof Error ? e.message : e);
      return fail("Something went wrong signing in. Please try again.");
    }
  }

  private async insertSocial(userId: string, provider: string, label: string, secret: string, targetRef: string): Promise<void> {
    const keyId = newDataKeyId();
    await this.d.run(
      `insert into action_connections (user_id, kind, provider, label, token_ct, data_key_id, target_ref)
       values ($1, 'social', $2, $3, $4, $5, $6)`,
      [userId, provider, label, encryptToken(secret, keyId), keyId, targetRef]);
  }

  /** One row per X account; signing in to the same account again replaces it. */
  private async saveX(userId: string, cred: x.XCredential): Promise<void> {
    await this.d.run(`delete from action_connections where user_id = $1 and provider = 'x' and target_ref = $2`, [userId, cred.username]);
    await this.insertSocial(userId, "x", `X (@${cred.username})`, JSON.stringify(cred), cred.username);
  }

  /** One row per Page and one per linked Instagram account. Connecting again replaces them all,
   *  so Pages the person no longer shares disappear. */
  private async saveMeta(userId: string, pages: meta.MetaPage[]): Promise<void> {
    await this.d.run(`delete from action_connections where user_id = $1 and provider in ('facebook', 'instagram')`, [userId]);
    for (const p of pages) {
      const secret = JSON.stringify({ pageToken: p.token } satisfies meta.MetaCredential);
      await this.insertSocial(userId, "facebook", `Facebook (${p.name})`, secret, p.id);
      if (p.instagram) await this.insertSocial(userId, "instagram", `Instagram (@${p.instagram.username || p.name})`, secret, p.instagram.id);
    }
  }

  /** Deletes the row outright, token included: a disconnected account leaves nothing behind. */
  async disconnect(userId: string, id: string): Promise<void> {
    const { rows } = await this.d.run(`delete from action_connections where id = $1 and user_id = $2 returning id`, [id, userId]);
    if (!rows.length) throw new ActionError("not_found", "No such connection.");
  }

  /* ---------------- the person's world, as the rules see it ---------------- */

  async context(userId: string): Promise<Context> {
    const sandbox = await this.sandbox(userId);
    const usage = this.store.usage(userId);
    return {
      connections: (await this.connections(userId)).map((c) => ({
        id: c.id, kind: c.kind as Context["connections"][number]["kind"], label: c.label,
        ...(isPlatform(c.platform) ? { platform: c.platform } : {}),
      })),
      lists: [],
      // Posts that went out, so the duplicate and repeat rules see them.
      recentPosts: this.store.list(userId)
        .filter((p) => p.kind === "social.post" && (p.status === "executed" || p.status === "executing"))
        .map((p) => ({ connectionId: String(p.payload.connectionId), text: String(p.payload.text), at: p.approvedAt ?? p.createdAt })),
      usageToday: usage.usageToday,
      spendCapCents: 0, // spending stays off until there is a setting for it
      spentThisMonthCents: usage.spentThisMonthCents,
      siteScans: { [sandbox.siteId]: await sandbox.scan() },
      siteDigests: { [sandbox.siteId]: await sandbox.digest() },
    };
  }

  /* ---------------- the assistant ---------------- */

  /**
   * One request to Hera. With a `conversationId` from an earlier answer, it continues that task
   * (an answer to her question, or a follow-up like "make the header blue"); otherwise it starts a
   * new one. Returns the id to send with the next reply, or null if the task can't continue.
   */
  async run(userId: string, request: string, opts: { mode: AgentMode; allowWebSearch?: boolean; photoId?: unknown; schedule?: unknown; conversationId?: unknown }): Promise<AgentResult & { proposals: ProposalView[]; conversationId: string | null }> {
    if (!this.d.client) throw new ActionError("ai_unavailable", "The assistant needs the AI key, which isn't set on this server.");
    let schedule: ScheduleSnapshot | undefined;
    if (opts.mode === "schedule") {
      const parsed = ScheduleSnapshot.safeParse(opts.schedule);
      if (!parsed.success) throw new ActionError("bad_schedule", "Your calendar couldn't be read for this request. Check that Hera can see your calendar, then try again.");
      schedule = parsed.data;
    }
    let photoId: string | null = null;
    if (opts.photoId != null) {
      if (typeof opts.photoId !== "string" || !(await this.media.owns(this.siteIdFor(userId), opts.photoId))) {
        throw new ActionError("bad_media", "That photo is no longer available. Add it again.");
      }
      photoId = opts.photoId;
    }
    const ctx = await this.context(userId);
    const sandbox = await this.sandbox(userId);
    const priorId = typeof opts.conversationId === "string" && /^[0-9a-f-]{36}$/i.test(opts.conversationId) ? opts.conversationId : null;
    const resume = priorId ? await this.memory.conversation(userId, priorId, opts.mode) : null;
    const memories = (await this.memory.memories(userId)).map((m) => m.text);
    const out = await runAgent({
      mode: opts.mode, client: this.d.client, store: this.store, sandbox, userId, context: () => ctx,
      allowWebSearch: opts.allowWebSearch, sleep: this.d.sleep, photoId, schedule, memories,
      remember: async (fact) => (await this.memory.remember(userId, fact)).message,
    }, request, resume);
    // A conversation that expired or was never this person's starts fresh under a new id.
    const conversationId = await this.memory.saveConversation(userId, resume ? priorId : null, opts.mode, out.state);
    return { ...out, proposals: out.proposalIds.map((id) => viewOf(this.store.get(id, userId))), conversationId };
  }

  /* ---------------- approvals ---------------- */

  list(userId: string): ProposalView[] {
    return this.store.list(userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(viewOf);
  }

  approve(userId: string, id: string, body: { payloadHash: unknown; attestations?: unknown; acknowledgeTaint?: unknown; typedAmount?: unknown }) {
    const p = this.store.get(id, userId);
    if (!EXECUTABLE.has(p.kind)) {
      throw new ActionError("not_connected", "This can't be carried out yet: the app has no connection for it. It stays saved as a draft.");
    }
    return this.store.approve({
      id, userId,
      payloadHash: String(body.payloadHash ?? ""),
      attestations: Array.isArray(body.attestations) ? body.attestations.filter((a): a is string => typeof a === "string") : [],
      acknowledgeTaint: body.acknowledgeTaint === true,
      typedAmount: typeof body.typedAmount === "string" ? body.typedAmount : undefined,
    });
  }

  reject(userId: string, id: string): void {
    this.store.reject(id, userId);
  }

  async execute(userId: string, id: string, token: unknown): Promise<ProposalView> {
    const ctx = await this.context(userId);
    const p = await this.store.execute({
      id, userId, token: String(token ?? ""), ctx,
      executor: (kind, payload) => this.carryOut(userId, kind, payload),
    });
    return viewOf(p);
  }

  private async carryOut(userId: string, kind: ActionKind, payload: Readonly<Record<string, unknown>>): Promise<ExecutionResult> {
    if (kind === "social.post") return this.carryOutPost(userId, payload);
    if (kind !== "site.deploy") return { ok: false, detail: "No connection can carry this out yet." };
    const { rows } = await this.d.run(
      `select id, token_ct, data_key_id, target_ref from action_connections
        where id = $1 and user_id = $2 and kind = 'hosting' and revoked_at is null`,
      [payload.connectionId, userId]);
    const c = rows[0];
    if (!c) return { ok: false, detail: "That hosting connection is no longer there." };

    const sandbox = await this.sandbox(userId);
    // The rules already compared fingerprints a moment ago; compare once more immediately
    // before the upload, so nothing written in between can reach the public.
    if ((await sandbox.digest()) !== payload.contentHash) return { ok: false, detail: "The site changed after it was approved." };
    const files = await sandbox.bundle();

    const token = decryptToken(Buffer.from(c.token_ct), c.data_key_id);
    try {
      const out = await publish(token, files, c.target_ref ?? null, { fetch: this.d.fetch, sleep: this.d.sleep });
      if (out.siteId !== c.target_ref) {
        await this.d.run(`update action_connections set target_ref = $2 where id = $1`, [c.id, out.siteId]);
      }
      return { ok: true, ref: out.url, detail: `Published at ${out.url}` };
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "unauthorized") {
        await this.d.run(`update action_connections set revoked_at = now() where id = $1`, [c.id]);
        return { ok: false, detail: "Netlify no longer accepts this connection. Reconnect it in the app." };
      }
      if (e instanceof ProviderError) return { ok: false, detail: e.message };
      throw e;
    }
  }

  private async carryOutPost(userId: string, payload: Readonly<Record<string, unknown>>): Promise<ExecutionResult> {
    const { rows } = await this.d.run(
      `select id, provider, token_ct, data_key_id, target_ref from action_connections
        where id = $1 and user_id = $2 and kind = 'social' and revoked_at is null`,
      [payload.connectionId, userId]);
    const c = rows[0];
    if (!c) return { ok: false, detail: "That social account is no longer connected." };

    const secret = decryptToken(Buffer.from(c.token_ct), c.data_key_id);
    const text = String(payload.text);
    const link = (payload.link as string | null) ?? null;
    const mediaRefs = (payload.mediaRefs as string[] | undefined) ?? [];
    const owner = this.siteIdFor(userId);
    for (const id of mediaRefs) {
      if (!(await this.media.owns(owner, id))) return { ok: false, detail: "The photo for this post is no longer available. Ask Hera for the post again with the photo." };
    }
    const imageUrl = mediaRefs[0] ? this.photoUrl(mediaRefs[0]) : null;
    if (mediaRefs.length && !imageUrl) return { ok: false, detail: "Posting photos isn't set up on this server yet." };

    try {
      let url: string;
      switch (c.provider) {
        case "bluesky":
          url = (await publishPost(JSON.parse(secret) as BlueskyCredential, { text, link }, { fetch: this.d.fetch })).url;
          break;
        case "x": {
          const client = this.d.oauth?.x;
          if (!client) return { ok: false, detail: "Posting to X isn't set up on this server." };
          const before = JSON.parse(secret) as x.XCredential;
          const cred = await x.freshCredential(client, before, this.d.fetch);
          // X replaces the refresh token on every use, so save the new one before anything else.
          if (cred !== before) {
            const keyId = newDataKeyId();
            await this.d.run(`update action_connections set token_ct = $2, data_key_id = $3 where id = $1`,
              [c.id, encryptToken(JSON.stringify(cred), keyId), keyId]);
          }
          url = (await x.publishPost(cred, { text, link }, this.d.fetch)).url;
          break;
        }
        case "facebook":
          url = (await meta.publishFacebook(JSON.parse(secret) as meta.MetaCredential, c.target_ref, { text, link, imageUrl }, this.d.fetch)).url;
          break;
        case "instagram":
          if (!imageUrl) return { ok: false, detail: "Instagram posts need a photo." };
          url = (await meta.publishInstagram(JSON.parse(secret) as meta.MetaCredential, c.target_ref, { caption: text, imageUrl }, { fetch: this.d.fetch, sleep: this.d.sleep })).url;
          break;
        default:
          return { ok: false, detail: "Posting to this platform isn't supported yet." };
      }
      return { ok: true, ref: url, detail: `Posted at ${url}` };
    } catch (e) {
      const name = PROVIDER_NAMES[c.provider] ?? c.provider;
      if (e instanceof ProviderError && e.kind === "unauthorized") {
        await this.d.run(`update action_connections set revoked_at = now() where id = $1`, [c.id]);
        return { ok: false, detail: c.provider === "bluesky"
          ? "Bluesky no longer accepts this app password. Reconnect the account in the app."
          : `${name} no longer accepts this connection. Reconnect it in the app.` };
      }
      if (e instanceof ProviderError) return { ok: false, detail: e.message };
      throw e;
    }
  }

  /* ---------------- the site, for the person to review ---------------- */

  async site(userId: string) {
    const sandbox = await this.sandbox(userId);
    return { files: await sandbox.files(), checks: await sandbox.scan(), contentHash: await sandbox.digest() };
  }

  async siteFile(userId: string, path: unknown): Promise<string> {
    return (await this.sandbox(userId)).read(String(path ?? ""));
  }
}
