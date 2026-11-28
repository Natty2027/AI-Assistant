/**
 * Every endpoint the Hera app calls, plus /health and the public support, privacy and terms pages.
 *
 * Handlers stay thin: they authenticate, validate, and delegate to the assistant in agent/.
 */
import { config } from "./config.ts";
import { requireAuth } from "./auth.ts";
import { dbConfigured, dbReachable, pool, query } from "./db.ts";
import { HttpError, Router, sendHtml } from "./http.ts";
import { privacyPage, supportPage, termsPage } from "./pages.ts";
import { adminAllowed, growth, growthPage, homePage } from "./marketing.ts";
import { createLimiter } from "./rateLimit.ts";
import { assertUuid, ProviderError } from "./shared.ts";
import Anthropic from "@anthropic-ai/sdk";
import { AgentService } from "./agent/service.ts";
import { AGENT_MODES, describeAiError, type AgentMode } from "./agent/loop.ts";
import { ActionError, ActionStore, sqlProposalSink } from "./agent/approvals.ts";
import { isOAuthProvider } from "./agent/oauth.ts";
import { challengeResponse } from "./agent/ebay.ts";
import { RunJobs, sqlRunSink, type ReportText, type RunFailure } from "./agent/runs.ts";
import { Billing, BillingError } from "./billing.ts";

const writeLimiter = createLimiter({ windowMs: 60_000, max: 20 });
// Each assistant run can be many model calls, so it gets a much tighter budget.
const agentRunLimiter = createLimiter({ windowMs: 3_600_000, max: 10 });
// A Talk turn is one thing said in a conversation: short, and many of them in a few minutes.
const talkTurnLimiter = createLimiter({ windowMs: 3_600_000, max: 240 });

let agentService: AgentService | null = null;
/** Resolves once saved proposals are back in memory after a restart. */
let agentReady: Promise<void> = Promise.resolve();
const sqlRun = (sql: string, params?: unknown[]) => query(sql, params ?? []) as Promise<{ rows: any[] }>;

/** One per process: it owns the proposal store, which writes through to the database. */
function agent(): AgentService {
  if (!dbConfigured()) throw new HttpError(503, "The assistant needs the database, which isn't connected yet.");
  if (!agentService) {
    const sink = sqlProposalSink(sqlRun);
    const store = new ActionStore(undefined, sink);
    agentReady = sink.load().then((saved) => store.restore(saved)).catch((e) => {
      // Before migration 007 there's nowhere to save them: proposals then live in memory only.
      console.error("[approvals] couldn't load saved proposals (has db/migrations/007 been run?)", e instanceof Error ? e.message : e);
    });
    agentService = makeService(store);
  }
  return agentService;
}

function makeService(store: ActionStore): AgentService {
  return new AgentService({
    store,
    run: sqlRun,
    fetch: (url, init) => fetch(url, init),
    sitesDir: config.sitesDir,
    mediaDir: config.mediaDir,
    oauth: { publicUrl: config.publicUrl, x: config.x, meta: config.meta, metaConfigId: config.metaConfigId,
      ebay: config.ebay, ebayRuName: config.ebayRuName, ebaySandbox: config.ebaySandbox, microsoft: config.microsoft },
    // maxRetries 0: the agent loop retries through withAiRetry, so the SDK must not retry too.
    client: config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 }) : null,
  });
}

/** Turns the agent's typed failures into HTTP answers a person can read. */
function agentFailure(e: unknown): never {
  if (e instanceof ActionError) {
    const status: Record<string, number> = { not_found: 404, unknown_action: 400, bad_token: 400, bad_media: 400, bad_schedule: 400, ai_unavailable: 503, provider_unavailable: 502,
      bad_setting: 400, bad_address: 400, bad_email: 400, no_recipient: 400, too_many_recipients: 400, not_allowed: 403 };
    throw new HttpError(status[e.code] ?? 409, e.message, true, e.code);
  }
  if (e instanceof ProviderError) throw new HttpError(502, "The service could not complete that. Try again shortly.", true, "provider_unavailable");
  throw e;
}
// Waits for saved proposals to be loaded, so nothing reads the store half-restored.
const guarded = <T>(fn: () => Promise<T> | T): Promise<T> => agentReady.then(fn).catch(agentFailure);

/** What the app is told when a background run fails: the same answers as a direct request. */
function runFailure(e: unknown): RunFailure {
  if (e instanceof HttpError && e.expose) return { status: e.status, message: e.message, code: e.code };
  console.error("[run failed]", describeAiError(e), e instanceof Error && e.stack ? e.stack.split("\n").slice(1, 4).join(" <- ") : "");
  return { status: 500, message: "Something went wrong on our side. Please try again.", code: "run_failed" };
}
const billing = new Billing(sqlRun, config.billing);

/** Billing's refusals as answers the app understands: 402 for a used-up month. */
async function billed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BillingError) throw new HttpError(e.code === "limit_reached" ? 402 : 400, e.message, true, e.code);
    // Before migration 008 there's nowhere to count; with limits off, that's no reason to fail.
    if (!config.billing.enforced && (e as { code?: string })?.code === "42P01") return undefined as T;
    throw e;
  }
}

const runJobs = new RunJobs(runFailure, undefined, undefined, sqlRunSink(sqlRun));

/**
 * A deploy or restart: stop taking new requests to Hera, let the ones in flight finish (up to
 * `maxMs`), and make sure every proposal change has been saved.
 */
/** Posts scheduled posts when their time comes: checks every minute once the server is up. */
let scheduler: ReturnType<typeof setInterval> | null = null;
export function startScheduler(): void {
  if (scheduler || !dbConfigured()) return;
  scheduler = setInterval(() => {
    void agentReady.then(() => agent().runDue()).catch((e) => console.error("[schedule]", e instanceof Error ? e.message : e));
  }, 60_000);
  scheduler.unref();
  // Load saved proposals now, so posts due during a restart go out within a minute.
  agent();
}

export async function shutdown(maxMs: number): Promise<void> {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
  await runJobs.drain(maxMs);
  await agentService?.store.flush();
}

/** user_settings is created lazily; every table keys on it, so make sure the row exists. */
async function ensureSettings(userId: string): Promise<void> {
  await query(`insert into user_settings (user_id) values ($1) on conflict do nothing`, [userId]);
}

/**
 * Nothing the person writes may reach the model provider until they have said yes. The check
 * reads the database every time rather than trusting a cached or client-supplied flag, so
 * revoking consent takes effect on the very next request.
 */
async function requireAiConsent(userId: string): Promise<void> {
  const { rows } = await query<{ ai_consent_at: Date | null }>(
    `select ai_consent_at from user_settings where user_id = $1`, [userId]
  );
  if (!rows[0]?.ai_consent_at) {
    throw new HttpError(
      403,
      "AI processing is off. Turn it on in Settings to use the assistant.",
      true,
      "ai_consent_required"
    );
  }
}

/**
 * Every table that can hold a row for the user, in deletion order; user_settings goes last.
 * The calendar tables (events_cache, oauth_connections and so on) are no longer written by the
 * server but are still in the schema, so deleting from them keeps account deletion complete.
 */
const USER_DATA_TABLES = [
  "safety_events", "habit_observations", "habit_profiles", "proposed_events",
  "events_cache", "connection_disclosures", "oauth_connections", "action_connections",
  "agent_conversations", "agent_memories", "agent_proposals", "agent_runs", "user_plans", "agent_usage", "user_settings",
] as const;
/** Added by a later migration; skipped, not failed on, in a database that doesn't have them yet. */
const OPTIONAL_TABLES = new Set<string>(["agent_conversations", "agent_memories", "agent_proposals", "agent_runs", "user_plans", "agent_usage"]);

/**
 * The mode a request to Hera asks for. Apps from before modes existed send none: they get Posts.
 * Building websites was removed; an app that still offers it is told to update, with its own
 * code so it can say so plainly.
 */
export function checkMode(raw: unknown): AgentMode {
  const mode = raw ?? "posts";
  if (mode === "site") throw new HttpError(410, "Building websites was removed from Hera. Update the app to the latest version.", true, "mode_removed");
  if (!(AGENT_MODES as readonly unknown[]).includes(mode)) throw new HttpError(400, "mode must be 'posts', 'schedule', 'launch' or 'talk'.");
  return mode as AgentMode;
}

/** ?wait= on a run check: whole seconds, 0 to 25. Anything else means don't wait. */
export function waitSeconds(raw: string | null): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.min(25, Math.max(0, Math.floor(n))) : 0;
}

/** &after= on a run check: how many characters of the reply the app already has; null if absent. */
export function afterLength(raw: string | null): number | null {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : null;
}

/* ------------------------------ routes ------------------------------ */

export function buildRouter(): Router {
  const r = new Router();

  /* ---- public pages: App Store Connect needs live Support, Privacy Policy and Marketing URLs ---- */
  r.get("/", (ctx) => sendHtml(ctx.res, homePage(config, config.supportEmail)));

  /* ---- the owner's growth dashboard: counts only, behind ADMIN_TOKEN (the browser asks) ---- */
  r.get("/admin/growth", async (ctx) => {
    if (!adminAllowed(ctx.req.headers.authorization, config.adminToken)) {
      ctx.res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Hera growth"', "Content-Type": "text/plain" });
      ctx.res.end(config.adminToken ? "Sign in with any user name and ADMIN_TOKEN as the password." : "Set ADMIN_TOKEN (24+ characters) in Railway Variables first.");
      return;
    }
    const page = growthPage(await growth(sqlRun));
    ctx.res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
    ctx.res.end(page);
  });
  r.get("/support", (ctx) => sendHtml(ctx.res, supportPage(config.supportEmail)));
  r.get("/privacy", (ctx) => sendHtml(ctx.res, privacyPage(config.supportEmail)));
  r.get("/terms", (ctx) => sendHtml(ctx.res, termsPage(config.supportEmail)));

  r.get("/health", async () => ({
    ok: true,
    db: dbConfigured() ? ((await dbReachable()) ? "reachable" : "unreachable") : "not_configured",
    ai: Boolean(config.anthropicApiKey),
    // Only whether sign-in is set up. Whether test or developer access is on is not advertised,
    // so nobody learns that a shared secret would be worth guessing.
    auth: { supabaseKeys: Boolean(config.supabaseUrl), supabaseJwt: Boolean(config.supabaseJwtSecret) },
    // Which sign-ins for posting are configured (developer app keys plus PUBLIC_URL).
    publishing: {
      x: Boolean(config.publicUrl && config.x),
      meta: Boolean(config.publicUrl && config.meta),
      ebay: Boolean(config.publicUrl && config.ebay && config.ebayRuName),
      ebayDeletionNotices: Boolean(config.publicUrl && config.ebayVerificationToken),
      outlook: Boolean(config.publicUrl && config.microsoft),
    },
  }));

  /* ---- photos attached to posts: public, because Meta downloads them to post on Instagram.
     Addresses are unguessable (see agent/media.ts) and the file name is checked exactly. ---- */
  r.get("/media/:file", async (ctx) => {
    const bytes = await agent().media.read(ctx.params.file);
    if (!bytes) throw new HttpError(404, "Not found.");
    ctx.res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": bytes.length });
    ctx.res.end(bytes);
  });

  /* ---- eBay's account-deletion notices. eBay requires this address before it issues live keys:
     a GET with a challenge proves we own it; a POST says an eBay user deleted their account, and
     their connection is removed. Public by design (eBay calls it). ---- */
  r.get("/notifications/ebay/deletion", async (ctx) => {
    const challenge = ctx.url.searchParams.get("challenge_code");
    if (!challenge || !config.ebayVerificationToken || !config.publicUrl) throw new HttpError(404, "Not found.");
    const endpoint = `${config.publicUrl}/notifications/ebay/deletion`;
    return { challengeResponse: challengeResponse(challenge, config.ebayVerificationToken, endpoint) };
  });

  r.post("/notifications/ebay/deletion", async (ctx) => {
    const data = (ctx.body as any)?.notification?.data;
    const userId = typeof data?.userId === "string" ? data.userId : null;
    if (userId && /^[\w.-]{1,128}$/.test(userId)) await agent().ebayAccountDeleted(userId);
    // Acknowledged either way, so eBay doesn't keep resending.
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  /* ---- X and Meta send the browser back here after the person signs in. Public: the one-time
     state in the address identifies whose sign-in it is (see agent/oauth.ts). ---- */
  r.get("/oauth/callback/:provider", async (ctx) => {
    const provider = ctx.params.provider;
    if (!isOAuthProvider(provider)) throw new HttpError(404, "Not found.");
    const next = await agent().finishOAuth(provider, ctx.url.searchParams);
    ctx.res.writeHead(302, { Location: next });
    ctx.res.end();
  });

  /* ---- AI consent: explicit, revocable, and checked server-side on every assistant run ---- */
  r.get("/consent/ai", async (ctx) => {
    const userId = requireAuth(ctx);
    await ensureSettings(userId);
    const { rows } = await query<{ ai_consent_at: Date | null }>(
      `select ai_consent_at from user_settings where user_id = $1`, [userId]
    );
    const at = rows[0]?.ai_consent_at ?? null;
    return { granted: Boolean(at), at: at ? new Date(at).toISOString() : null };
  });

  r.post("/consent/ai", async (ctx) => {
    const userId = requireAuth(ctx);
    if (typeof ctx.body.granted !== "boolean") throw new HttpError(400, "granted must be true or false");
    await ensureSettings(userId);
    await query(
      `update user_settings
          set ai_consent_at = case when $2::boolean then now() else null end
        where user_id = $1`,
      [userId, ctx.body.granted]
    );
    return { ok: true, granted: ctx.body.granted };
  });

  /* ---- delete everything held about the user ---- */
  r.post("/account/delete", async (ctx) => {
    const userId = requireAuth(ctx);
    if (ctx.body.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm.");

    const client = await pool().connect();
    try {
      await client.query("begin");
      for (const table of USER_DATA_TABLES) {
        if (OPTIONAL_TABLES.has(table)) {
          const { rows } = await client.query(`select to_regclass($1) as t`, [`public.${table}`]);
          if (!rows[0]?.t) continue;
        }
        await client.query(`delete from ${table} where user_id = $1`, [userId]);
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    // Their photos and any old website files (on the volume) and proposals (in memory) are theirs too.
    await agent().forget(userId);
    // Apple requires deleting the account itself, not only its data (guideline 5.1.1(v)).
    // The data is already gone, so a retry after a failure here is safe and finishes the job.
    if (config.supabaseUrl && config.supabaseServiceRoleKey && userId !== config.testUserId) {
      let res: Response;
      try {
        res = await fetch(`${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: "DELETE",
          headers: { apikey: config.supabaseServiceRoleKey, Authorization: `Bearer ${config.supabaseServiceRoleKey}` },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new HttpError(502, "Your data was deleted, but we couldn't close your sign-in account. Please try again.");
      }
      if (!res.ok && res.status !== 404) {
        throw new HttpError(502, "Your data was deleted, but we couldn't close your sign-in account. Please try again.");
      }
    }
    // audit_log is append-only by design and keeps its rows; the app signs out and clears local data.
    return { ok: true, accountDeleted: Boolean(config.supabaseUrl && config.supabaseServiceRoleKey) };
  });

  /* ---- the assistant: draft promotion, propose; the person approves ---- */

  r.get("/agent/connections", async (ctx) => {
    const userId = requireAuth(ctx);
    // `signIn` tells the app which Connect buttons can work on this server.
    return { connections: await guarded(() => agent().connections(userId)), signIn: agent().oauthAvailable() };
  });

  /** Starts connecting X ("x") or Facebook and Instagram ("meta"): returns the platform's sign-in page. */
  r.get("/agent/connections/oauth/:provider", async (ctx) => {
    const userId = requireAuth(ctx);
    const provider = ctx.params.provider;
    if (!isOAuthProvider(provider)) throw new HttpError(404, "Not found.");
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    return { auth_url: await guarded(() => agent().beginOAuth(userId, provider)) };
  });

  /** Saves a finished sign-in. Only the person who started it can, so a sign-in link sent to
   *  someone else can't attach their account to the sender's Hera. */
  r.post("/agent/connections/oauth/confirm", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    await ensureSettings(userId);
    const out = await guarded(() => agent().confirmOAuth(userId, ctx.body.pending));
    return { ok: true, note: out.note };
  });

  /** A photo for the next posts run, as base64 JPEG. Returns its id for /agent/run. */
  r.post("/agent/media", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    return { ok: true, id: await guarded(() => agent().savePhoto(userId, ctx.body.data)) };
  });

  r.post("/agent/connections/bluesky", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    await ensureSettings(userId);
    return { ok: true, connection: await guarded(() => agent().connectBluesky(userId, ctx.body.identifier, ctx.body.app_password)) };
  });

  /** A connection's settings. Today only Outlook's "Let Hera read my Outlook inbox" (read_inbox). */
  r.post("/agent/connections/:id/settings", async (ctx) => {
    const userId = requireAuth(ctx);
    assertUuid(ctx.params.id);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    return { ok: true, connection: await guarded(() => agent().setInboxReading(userId, ctx.params.id, ctx.body.read_inbox)) };
  });

  /** "Send from Outlook" on an email Hera wrote: makes it a proposal, which the person then
   *  approves and executes like any other. Nothing is sent here. */
  r.post("/agent/emails/outlook", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    return { ok: true, proposal: await guarded(() => agent().proposeEmail(userId, ctx.body)) };
  });

  r.delete("/agent/connections/:id", async (ctx) => {
    const userId = requireAuth(ctx);
    assertUuid(ctx.params.id);
    await guarded(() => agent().disconnect(userId, ctx.params.id));
    return { ok: true };
  });

  /**
   * Checks a request to Hera and returns the work that answers it. Shared by /agent/run (waits for
   * the answer) and /agent/runs (answers later), so both apply the same rules and limits.
   */
  async function prepareRun(userId: string, body: Record<string, any>): Promise<(report?: ReportText) => Promise<unknown>> {
    const request = typeof body.request === "string" ? body.request.trim() : "";
    if (!request || request.length > 4000) throw new HttpError(400, "Describe what you'd like, in up to 4000 characters.");
    const mode = checkMode(body.mode);
    await ensureSettings(userId);
    // What the person writes is sent to the model provider, so the AI consent switch applies.
    await requireAiConsent(userId);
    // Counted only once the run can actually happen, so refused requests don't use up the hour.
    if (mode === "talk" ? !talkTurnLimiter.hit(userId) : !agentRunLimiter.hit(userId)) {
      throw new HttpError(429, mode === "talk"
        ? "We've talked a lot this hour. Let's take a short break, then talk again."
        : "That's the limit of assistant runs for this hour. Try again later.");
    }
    // This month's requests: counted now, refused when used up (only once BILLING is on).
    await billed(() => billing.useOne(userId));
    return async (report) => {
      const out = await guarded(() => agent().run(userId, request, {
        mode, allowWebSearch: body.allow_web_search === true,
        // A photo goes on posts, posters and listings, in Posts, a launch or a conversation.
        photoId: mode === "posts" || mode === "launch" || mode === "talk" ? body.photo_id ?? null : null,
        // Their calendar and reminders as their device sees them, for this request; never stored on its own.
        schedule: mode === "schedule" || mode === "launch" || mode === "talk" ? body.schedule : undefined,
        // Continue an earlier task: the id from the previous answer.
        conversationId: body.conversation_id,
        // A text message the person received and shared, to explain or help answer.
        receivedText: body.received_text,
        // The person's clock, for "Friday at 9" and scheduled posts.
        localTime: body.local_time,
        // Talk, from an app that asked for it: the reply so far, for the run's checks (see after).
        onText: body.stream === true ? report : undefined,
      }));
      return { status: out.status, text: out.text, proposals: out.proposals, drafts: out.drafts, scheduleChanges: out.scheduleChanges, emailDrafts: out.emailDrafts, textDrafts: out.textDrafts, posterDrafts: out.posterDrafts, tainted: out.tainted, conversationId: out.conversationId };
    };
  }

  r.post("/agent/run", async (ctx) => {
    const userId = requireAuth(ctx);
    return await (await prepareRun(userId, { ...ctx.body, stream: false }))();
  });

  /** Starts a request in the background and returns its id; the app checks /agent/runs/:id. */
  r.post("/agent/runs", async (ctx) => {
    const userId = requireAuth(ctx);
    // The same start sent again (the app didn't hear back): the run that's already going.
    const clientKey = typeof ctx.body?.client_run_id === "string" && ctx.body.client_run_id.length <= 100 ? ctx.body.client_run_id : null;
    const already = clientKey ? runJobs.findByClientKey(userId, clientKey) : null;
    if (already) return { run_id: already };
    if (runJobs.draining) throw new HttpError(503, "Hera is updating. Try again in a minute.", true, "updating");
    if (runJobs.isRunning(userId)) throw new HttpError(409, "Hera is still working on your last request. Wait for it to finish, then try again.", true, "run_in_progress");
    const work = await prepareRun(userId, ctx.body);
    return { run_id: runJobs.start(userId, work, clientKey) };
  });

  /** With ?wait=<seconds> (up to 25), answers as soon as the run finishes instead of right away,
   *  so the app hears the moment the answer is ready without checking every few seconds.
   *  With &after=<characters> as well (Talk), also as soon as the reply written so far is longer
   *  than that, and a running run then says what it is (partial_text). Without after, as before. */
  r.get("/agent/runs/:id", async (ctx) => {
    const userId = requireAuth(ctx);
    assertUuid(ctx.params.id);
    const wait = waitSeconds(ctx.url.searchParams.get("wait"));
    const after = afterLength(ctx.url.searchParams.get("after"));
    if (wait > 0) await runJobs.wait(userId, ctx.params.id, wait * 1000, after ?? undefined);
    const state = await runJobs.find(userId, ctx.params.id);
    if (!state) throw new HttpError(404, "Hera lost track of that request, probably because the server restarted. Please send it again.", true, "run_lost");
    if (state.status === "failed") throw new HttpError(state.failure.status, state.failure.message, true, state.failure.code);
    if (state.status === "finished") return { status: "finished", result: state.result };
    // Only a run going on this server has its reply so far; one elsewhere (a deploy) just says running.
    const partial = after === null ? null : runJobs.partial(userId, ctx.params.id);
    return partial === null ? { status: "running" } : { status: "running", partial_text: partial };
  });

  /* ---- Hera Pro: the plan, this month's requests, and redeeming an App Store purchase ---- */

  r.get("/billing/status", async (ctx) => {
    const userId = requireAuth(ctx);
    return (await billed(() => billing.status(userId))) ?? { plan: "free", used: 0, limit: config.billing.freeLimit, resetsAt: null, enforced: false, proExpiresAt: null };
  });

  r.post("/billing/verify", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    await ensureSettings(userId);
    return await billed(() => billing.redeem(userId, ctx.body.signed_transaction));
  });

  /* ---- what Hera remembers: the person sees, adds and deletes these in Settings ---- */

  r.get("/agent/memories", async (ctx) => {
    const userId = requireAuth(ctx);
    return { memories: await guarded(() => agent().memory.memories(userId)) };
  });

  r.post("/agent/memories", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    const text = typeof ctx.body.text === "string" ? ctx.body.text : "";
    if (!text.trim() || text.length > 300) throw new HttpError(400, "Write something for Hera to remember, in up to 300 characters.");
    await ensureSettings(userId);
    const out = await guarded(() => agent().memory.remember(userId, text));
    return { ok: true, memory: out.saved, message: out.message };
  });

  r.delete("/agent/memories/:id", async (ctx) => {
    const userId = requireAuth(ctx);
    assertUuid(ctx.params.id);
    if (!(await guarded(() => agent().memory.forgetMemory(userId, ctx.params.id)))) throw new HttpError(404, "That memory isn't there any more.");
    return { ok: true };
  });

  r.get("/agent/proposals", async (ctx) => {
    const userId = requireAuth(ctx);
    return { proposals: await guarded(() => agent().list(userId)) };
  });

  r.post("/agent/proposals/:id/approve", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    const out = await guarded(() => agent().approve(userId, ctx.params.id, {
      payloadHash: ctx.body.payload_hash, attestations: ctx.body.attestations,
      acknowledgeTaint: ctx.body.acknowledge_taint, typedAmount: ctx.body.typed_amount,
    }));
    return { ok: true, token: out.token, expires_at: out.expiresAt.toISOString() };
  });

  r.post("/agent/proposals/:id/execute", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    return { ok: true, proposal: await guarded(() => agent().execute(userId, ctx.params.id, ctx.body.token)) };
  });

  /** A post approved to go out at its time: the approval token is used up here. */
  r.post("/agent/proposals/:id/schedule", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    return { ok: true, proposal: await guarded(() => agent().schedulePost(userId, ctx.params.id, ctx.body.token)) };
  });

  r.post("/agent/proposals/:id/reject", async (ctx) => {
    const userId = requireAuth(ctx);
    await guarded(() => agent().reject(userId, ctx.params.id));
    return { ok: true };
  });

  return r;
}
