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
import { createLimiter } from "./rateLimit.ts";
import { assertUuid, ProviderError } from "./shared.ts";
import Anthropic from "@anthropic-ai/sdk";
import { AgentService } from "./agent/service.ts";
import { ActionError } from "./agent/approvals.ts";
import { SandboxError } from "./agent/sandbox.ts";

const writeLimiter = createLimiter({ windowMs: 60_000, max: 20 });
// Each assistant run can be many model calls, so it gets a much tighter budget.
const agentRunLimiter = createLimiter({ windowMs: 3_600_000, max: 10 });

let agentService: AgentService | null = null;
/** One per process: it owns the in-memory proposal store (see approvals.ts on persistence). */
function agent(): AgentService {
  if (!dbConfigured()) throw new HttpError(503, "The assistant needs the database, which isn't connected yet.");
  agentService ??= new AgentService({
    run: (sql, params) => query(sql, params ?? []) as Promise<{ rows: any[] }>,
    fetch: (url, init) => fetch(url, init),
    sitesDir: config.sitesDir,
    // maxRetries 0: the agent loop retries through withAiRetry, so the SDK must not retry too.
    client: config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 }) : null,
  });
  return agentService;
}

/** Turns the agent's typed failures into HTTP answers a person can read. */
function agentFailure(e: unknown): never {
  if (e instanceof ActionError) {
    const status: Record<string, number> = { not_found: 404, unknown_action: 400, bad_token: 400, ai_unavailable: 503, provider_unavailable: 502 };
    throw new HttpError(status[e.code] ?? 409, e.message, true, e.code);
  }
  if (e instanceof SandboxError) throw new HttpError(400, e.message, true, `site_${e.code}`);
  if (e instanceof ProviderError) throw new HttpError(502, "The service could not complete that. Try again shortly.", true, "provider_unavailable");
  throw e;
}
const guarded = <T>(fn: () => Promise<T> | T): Promise<T> => Promise.resolve().then(fn).catch(agentFailure);

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
  "events_cache", "connection_disclosures", "oauth_connections", "action_connections", "user_settings",
] as const;

/* ------------------------------ routes ------------------------------ */

export function buildRouter(): Router {
  const r = new Router();

  /* ---- public pages: App Store Connect needs live Support, Privacy Policy and Marketing URLs ---- */
  r.get("/", (ctx) => sendHtml(ctx.res, supportPage(config.supportEmail)));
  r.get("/support", (ctx) => sendHtml(ctx.res, supportPage(config.supportEmail)));
  r.get("/privacy", (ctx) => sendHtml(ctx.res, privacyPage(config.supportEmail)));
  r.get("/terms", (ctx) => sendHtml(ctx.res, termsPage(config.supportEmail)));

  r.get("/health", async () => ({
    ok: true,
    db: dbConfigured() ? ((await dbReachable()) ? "reachable" : "unreachable") : "not_configured",
    ai: Boolean(config.anthropicApiKey),
    auth: {
      // Sign in with Apple tokens from current Supabase projects, verified with the project's keys.
      supabaseKeys: Boolean(config.supabaseUrl),
      // Older projects that sign with the legacy shared secret.
      supabaseJwt: Boolean(config.supabaseJwtSecret),
      testToken: Boolean(config.testAccessToken && config.testUserId),
      devUser: Boolean(config.devUserId),
    },
  }));

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
        await client.query(`delete from ${table} where user_id = $1`, [userId]);
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    // Their website files (on the volume) and proposals (in memory) are theirs too.
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

  /* ---- the assistant: build a site, draft promotion, propose; the person approves ---- */

  r.get("/agent/connections", async (ctx) => {
    const userId = requireAuth(ctx);
    return { connections: await guarded(() => agent().connections(userId)) };
  });

  r.post("/agent/connections/netlify", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    await ensureSettings(userId);
    return { ok: true, connection: await guarded(() => agent().connectNetlify(userId, ctx.body.token)) };
  });

  r.post("/agent/connections/bluesky", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    await ensureSettings(userId);
    return { ok: true, connection: await guarded(() => agent().connectBluesky(userId, ctx.body.identifier, ctx.body.app_password)) };
  });

  r.delete("/agent/connections/:id", async (ctx) => {
    const userId = requireAuth(ctx);
    assertUuid(ctx.params.id);
    await guarded(() => agent().disconnect(userId, ctx.params.id));
    return { ok: true };
  });

  r.post("/agent/run", async (ctx) => {
    const userId = requireAuth(ctx);
    const request = typeof ctx.body.request === "string" ? ctx.body.request.trim() : "";
    if (!request || request.length > 4000) throw new HttpError(400, "Describe what you'd like, in up to 4000 characters.");
    await ensureSettings(userId);
    // What the person writes is sent to the model provider, so the AI consent switch applies.
    await requireAiConsent(userId);
    // Counted only once the run can actually happen, so refused requests don't use up the hour.
    if (!agentRunLimiter.hit(userId)) throw new HttpError(429, "That's the limit of assistant runs for this hour. Try again later.");
    const out = await guarded(() => agent().run(userId, request, { allowWebSearch: ctx.body.allow_web_search === true }));
    return { status: out.status, text: out.text, proposals: out.proposals, drafts: out.drafts, tainted: out.tainted };
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

  r.post("/agent/proposals/:id/reject", async (ctx) => {
    const userId = requireAuth(ctx);
    await guarded(() => agent().reject(userId, ctx.params.id));
    return { ok: true };
  });

  r.get("/agent/site", async (ctx) => {
    const userId = requireAuth(ctx);
    return await guarded(() => agent().site(userId));
  });

  r.get("/agent/site/file", async (ctx) => {
    const userId = requireAuth(ctx);
    return { contents: await guarded(() => agent().siteFile(userId, ctx.url.searchParams.get("path"))) };
  });

  return r;
}
