/**
 * Ties the assistant to a real person: their publishing connections, their website folder,
 * their proposals, and the executors that can carry an approved action out today
 * (publishing a site to Netlify, publishing a post to Bluesky).
 *
 * The database access and network are passed in, so the same code runs against Postgres and
 * Netlify in production and against PGlite and a fake Netlify in tests.
 */
import { createHash } from "node:crypto";
import { ActionError, ActionStore, type ExecutionResult, type Proposal } from "./approvals.ts";
import { ACTIONS, isPlatform, type ActionKind, type Context, type Platform } from "./policy.ts";
import { SiteSandbox } from "./sandbox.ts";
import { runAgent, type AgentDeps, type AgentMode, type AgentResult } from "./loop.ts";
import { publish, verifyToken } from "./netlify.ts";
import { parseCredential, publishPost, verifyCredential, type BlueskyCredential } from "./bluesky.ts";
import { ProviderError, type FetchLike, type Run } from "../shared.ts";
import { decryptToken, encryptToken, newDataKeyId } from "../crypto/envelope.ts";

/** What can actually be carried out today. Approving anything else is refused up front, so
 *  nobody approves something that has nowhere to go. A social post can only target a connected
 *  account, and Bluesky is the only social connection that can be made, so it is covered. */
export const EXECUTABLE: ReadonlySet<ActionKind> = new Set<ActionKind>(["site.deploy", "social.post"]);

/** Which platform each social provider posts to. */
const SOCIAL_PROVIDERS: Record<string, Platform> = { bluesky: "bluesky" };

export interface ServiceDeps {
  run: Run;
  fetch: FetchLike;
  sitesDir: string;
  /** null when no AI key is configured: everything except running the assistant still works. */
  client: AgentDeps["client"] | null;
  store?: ActionStore;
  sleep?: (ms: number) => Promise<void>;
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

  constructor(private readonly d: ServiceDeps) {
    this.store = d.store ?? new ActionStore();
  }

  /** Server-derived, never user- or model-supplied. */
  siteIdFor(userId: string): string {
    return `u-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
  }

  sandbox(userId: string): Promise<SiteSandbox> {
    return SiteSandbox.open(this.d.sitesDir, this.siteIdFor(userId));
  }

  /** Account deletion: the person's website files and their proposals. Connections live in the
   *  database and are deleted with the rest of their rows. */
  async forget(userId: string): Promise<void> {
    this.store.forget(userId);
    await SiteSandbox.remove(this.d.sitesDir, this.siteIdFor(userId));
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

  async run(userId: string, request: string, opts: { mode: AgentMode; allowWebSearch?: boolean }): Promise<AgentResult & { proposals: ProposalView[] }> {
    if (!this.d.client) throw new ActionError("ai_unavailable", "The assistant needs the AI key, which isn't set on this server.");
    const ctx = await this.context(userId);
    const sandbox = await this.sandbox(userId);
    const out = await runAgent({ mode: opts.mode, client: this.d.client, store: this.store, sandbox, userId, context: () => ctx, allowWebSearch: opts.allowWebSearch, sleep: this.d.sleep }, request);
    return { ...out, proposals: out.proposalIds.map((id) => viewOf(this.store.get(id, userId))) };
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
      `select id, provider, token_ct, data_key_id from action_connections
        where id = $1 and user_id = $2 and kind = 'social' and revoked_at is null`,
      [payload.connectionId, userId]);
    const c = rows[0];
    if (!c) return { ok: false, detail: "That social account is no longer connected." };
    if (c.provider !== "bluesky") return { ok: false, detail: "Posting to this platform isn't supported yet." };

    const cred = JSON.parse(decryptToken(Buffer.from(c.token_ct), c.data_key_id)) as BlueskyCredential;
    try {
      const out = await publishPost(cred, { text: String(payload.text), link: (payload.link as string | null) ?? null }, { fetch: this.d.fetch });
      return { ok: true, ref: out.url, detail: `Posted at ${out.url}` };
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "unauthorized") {
        await this.d.run(`update action_connections set revoked_at = now() where id = $1`, [c.id]);
        return { ok: false, detail: "Bluesky no longer accepts this app password. Reconnect the account in the app." };
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
