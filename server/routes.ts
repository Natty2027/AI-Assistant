/**
 * Every endpoint src/sw.ts calls, plus /health and /safety-events.
 *
 * Handlers stay thin: they authenticate, validate, and delegate. The AI modules under src/
 * are imported lazily so the server boots (and /health answers) without an Anthropic key.
 */
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "./config.ts";
import { requireAuth, assertLoopback } from "./auth.ts";
import { dbConfigured, dbReachable, pool, query } from "./db.ts";
import { HttpError, Router, type Ctx } from "./http.ts";
import { challengeFor, createVerifier, randomState } from "./oauth/pkce.ts";
import { decryptToken, encryptToken, newDataKeyId } from "./crypto/envelope.ts";
import { createLimiter } from "./rateLimit.ts";
import { saveConnection } from "./connections.ts";
import { assertUuid, confirmProposal, listPending, rejectProposal } from "./proposals.ts";
import { syncUser } from "./sync.ts";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "./calendar.ts";
import { AgentService } from "./agent/service.ts";
import { ActionError } from "./agent/approvals.ts";
import { SandboxError } from "./agent/sandbox.ts";

const aiLimiter = createLimiter({ windowMs: 60_000, max: 20 });
const writeLimiter = createLimiter({ windowMs: 60_000, max: 20 });
// Each assistant run can be many model calls, so it gets a much tighter budget than capture.
const agentRunLimiter = createLimiter({ windowMs: 3_600_000, max: 10 });

let agentService: AgentService | null = null;
/** One per process: it owns the in-memory proposal store (see approvals.ts on persistence). */
function agent(): AgentService {
  if (!dbConfigured()) throw new HttpError(503, "The assistant needs the database, which isn't connected yet.");
  agentService ??= new AgentService({
    run: (sql, params) => query(sql, params ?? []) as Promise<{ rows: any[] }>,
    fetch: (url, init) => fetch(url, init),
    sitesDir: config.sitesDir,
    client: config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null,
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
const syncLimiter = createLimiter({ windowMs: 60_000, max: 6 });

/** What the calendar modules need: the database, the network, and the provider credentials. */
function calendarDeps() {
  return {
    run: (sql: string, params?: unknown[]) => query(sql, params ?? []) as Promise<{ rows: any[] }>,
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
    cfg: { google: config.google, microsoft: config.microsoft },
  };
}

const PROVIDERS = ["google", "microsoft", "canvas_ical", "blackboard_ical"] as const;
type Provider = (typeof PROVIDERS)[number];
const OAUTH_PROVIDERS = ["google", "microsoft"] as const;

function str(v: unknown, name: string, max = 4000): string {
  if (typeof v !== "string" || !v.length) throw new HttpError(400, `${name} is required`);
  return v.slice(0, max);
}

function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** user_settings is created lazily; every table keys on it, so make sure the row exists. */
async function ensureSettings(userId: string, timezone?: unknown): Promise<string> {
  await query(`insert into user_settings (user_id) values ($1) on conflict do nothing`, [userId]);
  if (validTimezone(timezone)) {
    await query(`update user_settings set timezone = $2 where user_id = $1`, [userId, timezone]);
    return timezone;
  }
  const { rows } = await query<{ timezone: string }>(
    `select timezone from user_settings where user_id = $1`, [userId]
  );
  return rows[0]?.timezone ?? "UTC";
}

/**
 * Nothing the user captured may reach the model provider until they have said yes. The check
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
      "AI processing is off. Turn it on in Settings to capture events from text or images.",
      true,
      "ai_consent_required"
    );
  }
}

/** Every table that holds a row for the user, in deletion order. user_settings goes last. */
const USER_DATA_TABLES = [
  "safety_events", "habit_observations", "habit_profiles", "proposed_events",
  "events_cache", "connection_disclosures", "oauth_connections", "action_connections", "user_settings",
] as const;

/** Postgres exceptions raised by our own triggers start with "pcc:" and are safe to show. */
function rethrowDb(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("pcc:")) throw new HttpError(403, msg.replace(/^pcc:\s*/, ""));
  throw e;
}

/* ------------------------------ OAuth state ------------------------------ */

interface PendingAuth {
  verifier: string;
  userId: string;
  provider: Provider;
  redirect: string;
  expires: number;
}
// In-memory is fine for one instance. Move to the database before scaling horizontally.
const PENDING = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60_000;

function sweepPending(): void {
  const now = Date.now();
  for (const [k, v] of PENDING) if (v.expires < now) PENDING.delete(k);
}

/** Only extension redirect origins may receive an authorization code. */
const EXTENSION_REDIRECT = /^https:\/\/[a-z0-9]+\.(?:chromiumapp\.org|extensions\.allizom\.org)\//;

/* ------------------------------ image fetching ------------------------------ */

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 6) {
    const a = addr.toLowerCase();
    // ::1, ::, unique-local fc00::/7, link-local fe80::/10, multicast ff00::/8
    if (a === "::1" || a === "::" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a)) return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = addr.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking range
    a >= 224                                  // multicast and reserved
  );
}

/**
 * The URL comes from the browser, so treat it as hostile: https only, no private ranges, no
 * redirects, size-capped, short timeout. (A DNS-rebinding race between this lookup and the
 * fetch is possible; the redirect ban and the size/type checks bound what it could return.)
 */
async function loadImage(url: string): Promise<{ base64: string; mediaType: ImageType }> {
  const data = url.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (data) {
    if (!IMAGE_TYPES.includes(data[1] as ImageType)) throw new HttpError(415, "Unsupported image type");
    return { base64: data[2], mediaType: data[1] as ImageType };
  }

  let u: URL;
  try { u = new URL(url); } catch { throw new HttpError(400, "That image address isn't valid"); }
  if (u.protocol !== "https:") throw new HttpError(400, "Only https images can be read");
  // No embedded credentials, and no odd ports: both are ways to aim a request at something
  // that was never meant to be a public image host.
  if (u.username || u.password || (u.port && u.port !== "443")) {
    throw new HttpError(400, "That image address can't be read");
  }

  const addrs = await lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new HttpError(400, "That image address can't be read");
  }

  const { type, bytes } = await fetchPinned(u, addrs[0].address, addrs[0].family);
  return { base64: bytes.toString("base64"), mediaType: type };
}

/**
 * Downloads over TLS, connecting to the address that was just validated.
 *
 * Validating a hostname and then letting fetch() resolve it again leaves a gap: a hostile DNS
 * server can answer with a public address for the check and 169.254.169.254 for the request.
 * Pinning the connection to the checked address closes it, while certificate verification
 * still runs against the real hostname, so TLS is not weakened.
 */
export function fetchPinned(u: URL, address: string, family: number): Promise<{ type: ImageType; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const fail = (e: unknown) =>
      reject(e instanceof HttpError ? e : new HttpError(502, "Couldn't download that image"));

    const req = https.request(
      u,
      {
        method: "GET",
        timeout: 10_000,
        headers: { Accept: "image/*", "User-Agent": "cyber-companion/0.1" },
        // Node may ask for one address or for all of them, depending on autoSelectFamily.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
      },
      (res) => {
        // Redirects are refused outright: each hop would need the same validation.
        if (res.statusCode !== 200) { res.resume(); return fail(new HttpError(502, "Couldn't download that image")); }
        const type = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!IMAGE_TYPES.includes(type as ImageType)) {
          res.destroy();
          return fail(new HttpError(415, "That isn't a supported image"));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_IMAGE_BYTES) {
            res.destroy();
            return fail(new HttpError(413, "Image is larger than 5 MB"));
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ type: type as ImageType, bytes: Buffer.concat(chunks) }));
        res.on("error", fail);
      }
    );
    req.on("timeout", () => req.destroy(new HttpError(504, "That image took too long to download")));
    req.on("error", fail);
    req.end();
  });
}

/* ------------------------------ routes ------------------------------ */

const CRISIS_NOTICE =
  "It sounds like you may be going through something hard. I can't help with that from here, " +
  "but you can call or text 988 (US), or find a local line at findahelpline.com. " +
  "I've set the calendar aside for now.";

export function buildRouter(): Router {
  const r = new Router();

  r.get("/health", async () => ({
    ok: true,
    db: dbConfigured() ? ((await dbReachable()) ? "reachable" : "unreachable") : "not_configured",
    ai: Boolean(config.anthropicApiKey),
    auth: {
      supabaseJwt: Boolean(config.supabaseJwtSecret),
      testToken: Boolean(config.testAccessToken && config.testUserId),
      devUser: Boolean(config.devUserId),
    },
    oauth: { google: Boolean(config.google), microsoft: Boolean(config.microsoft) },
  }));

  /* ---- AI consent: explicit, revocable, and checked server-side on every capture ---- */
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

    // Revoke provider access before the tokens disappear. Google exposes a revoke endpoint;
    // Microsoft does not, so for it the user must remove the app in their account settings.
    // Best-effort: a failed revoke must not block the user's right to delete.
    const { rows: conns } = await query<{ provider: string; data_key_id: string; refresh_token_ct: Buffer | null }>(
      `select provider, data_key_id, refresh_token_ct from oauth_connections where user_id = $1`, [userId]
    );
    for (const c of conns) {
      if (c.provider !== "google" || !c.refresh_token_ct) continue;
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: decryptToken(c.refresh_token_ct, c.data_key_id) }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch { /* logged nowhere on purpose: the error could carry a token */ }
    }

    for (const [k, v] of PENDING) if (v.userId === userId) PENDING.delete(k);

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
    // audit_log is append-only by design and keeps its rows; the extension clears local data.
    return { ok: true };
  });

  /* ---- what the resolver reads to decide whether the assistant may speak ---- */
  r.get("/events/active", async (ctx) => {
    const userId = requireAuth(ctx);
    const { rows } = await query(
      `select title, category, busy, start_time, end_time
         from events_cache
        where user_id = $1 and busy and start_time <= now() and end_time > now()
        order by start_time`,
      [userId]
    );
    return rows.map((e) => ({
      title: e.title ?? "Busy",
      category: e.category === "assignment" ? "other" : e.category,
      busy: e.busy,
      start: new Date(e.start_time).toISOString(),
      end: new Date(e.end_time).toISOString(),
    }));
  });

  /* ---- the adaptive-automation toggle ---- */
  r.post("/settings/automation", async (ctx) => {
    const userId = requireAuth(ctx);
    if (typeof ctx.body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    await ensureSettings(userId);
    const { setAutomation, AutomationDisabledError } = await import("../src/adaptive/engine.ts");
    try {
      const out = await setAutomation(pool(), userId, ctx.body.enabled);
      return { ok: true, enabled: out.state === "on", purged: out.purged };
    } catch (e) {
      if (e instanceof AutomationDisabledError) throw new HttpError(403, e.message);
      throw e;
    }
  });

  /* ---- disclosure acknowledgement: the gate in front of every connection ---- */
  r.post("/disclosures", async (ctx) => {
    const userId = requireAuth(ctx);
    const provider = ctx.body.provider as Provider;
    if (!PROVIDERS.includes(provider)) throw new HttpError(400, "Unknown provider");
    const version = Number(ctx.body.version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "version must be a positive integer");
    await ensureSettings(userId);
    await query(
      `insert into connection_disclosures (user_id, provider, disclosure_version)
       values ($1, $2, $3) on conflict do nothing`,
      [userId, provider, version]
    );
    return { ok: true };
  });

  /* ---- OAuth, authorization code + PKCE. The extension never sees a secret or a token. ---- */
  r.get("/oauth/start", (ctx) => {
    const userId = requireAuth(ctx);
    const provider = ctx.url.searchParams.get("provider") as Provider | null;
    const redirect = ctx.url.searchParams.get("redirect") ?? "";

    if (!provider || !(OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
      throw new HttpError(400, "That provider connects with a calendar feed link, not a sign-in.");
    }
    const cfg = provider === "google" ? config.google : config.microsoft;
    if (!cfg) throw new HttpError(503, `${provider} sign-in isn't configured on this server yet.`);
    if (!EXTENSION_REDIRECT.test(redirect)) throw new HttpError(400, "Redirect address not allowed");

    sweepPending();
    const state = randomState();
    const verifier = createVerifier();
    PENDING.set(state, { verifier, userId, provider, redirect, expires: Date.now() + PENDING_TTL_MS });

    const p = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: cfg.scopes.join(" "),
      state,
      code_challenge: challengeFor(verifier),
      code_challenge_method: "S256",
    });
    if (provider === "google") { p.set("access_type", "offline"); p.set("prompt", "consent"); }
    return { authUrl: `${cfg.authUrl}?${p}` };
  });

  r.post("/oauth/complete", async (ctx) => {
    const userId = requireAuth(ctx);
    const provider = ctx.body.provider as Provider;
    let done: URL;
    try { done = new URL(str(ctx.body.done, "done", 4000)); } catch { throw new HttpError(400, "Bad redirect result"); }

    if (done.searchParams.get("error")) throw new HttpError(400, "Sign-in was cancelled or refused.");
    const code = done.searchParams.get("code");
    const state = done.searchParams.get("state") ?? "";
    const pending = PENDING.get(state);
    PENDING.delete(state); // single use, success or not

    if (!code || !pending || pending.expires < Date.now() || pending.userId !== userId || pending.provider !== provider) {
      throw new HttpError(400, "That sign-in attempt expired. Please try connecting again.");
    }
    const cfg = provider === "google" ? config.google : config.microsoft;
    if (!cfg) throw new HttpError(503, `${provider} sign-in isn't configured on this server yet.`);

    const tokenRes = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirect,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code_verifier: pending.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) {
      console.error(`[oauth] ${provider} token exchange failed: ${tokenRes.status}`); // status only, never the body
      throw new HttpError(502, "The provider didn't accept the sign-in. Please try again.");
    }
    const tok = (await tokenRes.json()) as {
      access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string;
    };
    if (!tok.access_token) throw new HttpError(502, "The provider returned no access token.");

    // Email comes from the id_token we just received directly over TLS from the token endpoint.
    let email: string | null = null;
    if (tok.id_token) {
      try {
        const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString("utf8"));
        email = typeof claims.email === "string" ? claims.email : null;
      } catch { /* email is a label only */ }
    }

    const keyId = newDataKeyId();
    await ensureSettings(userId);
    try {
      // Upsert, so reconnecting the same account works. See connections.ts for why a plain
      // insert fails the second time and why the disclosure gate still applies.
      await saveConnection(query, {
        userId, provider: provider as "google" | "microsoft", email,
        accessCt: encryptToken(tok.access_token, keyId),
        refreshCt: tok.refresh_token ? encryptToken(tok.refresh_token, keyId) : null,
        dataKeyId: keyId,
        scopes: (tok.scope ?? cfg.scopes.join(" ")).split(/[ ,]+/).filter(Boolean),
        expiresInSeconds: tok.expires_in ?? 3600,
      });
    } catch (e) {
      rethrowDb(e);
    }
    return { ok: true };
  });

  /* ---- capture: selected text or an image -> proposals awaiting confirmation ---- */
  r.post("/capture", async (ctx) => {
    const userId = requireAuth(ctx);
    // Each capture is a paid model call, so cap it per user, not per address.
    if (!aiLimiter.hit(userId)) throw new HttpError(429, "Too many captures. Wait a moment and try again.");
    if (!config.anthropicApiKey) throw new HttpError(503, "Capture needs the AI key, which isn't set on this server.");

    // Consent lives in the database, so capture cannot run without one. That is the point:
    // there is no unrecorded path to the model.
    if (!dbConfigured()) throw new HttpError(503, "Capture needs the database so your AI consent can be checked.");
    const timezone = await ensureSettings(userId, ctx.body.timezone);
    await requireAiConsent(userId);
    const kind = ctx.body.kind;

    const vision = await import("../src/vision/imageToEvents.ts");
    let extraction;
    let sourceRef: string;

    try {
      if (kind === "image") {
        const url = str(ctx.body.url, "url", 2_000_000);
        const img = await loadImage(url);
        extraction = await vision.extractEventsFromImage({
          imageBase64: img.base64, mediaType: img.mediaType, userId, userTimezone: timezone,
        });
        sourceRef = url.startsWith("data:") ? "inline-image" : url.slice(0, 500);
      } else if (kind === "text") {
        const { moderateInput } = await import("../src/safety/moderation.ts");
        const raw = str(ctx.body.text, "text", 8000);
        const verdict = await moderateInput(raw, { source: "text", userId });
        if (verdict.action === "crisis") return { proposals: [], notice: CRISIS_NOTICE };
        if (verdict.action === "block") return { proposals: [], notice: verdict.userMessage };
        const text = verdict.action === "redact" ? verdict.sanitized : raw;
        extraction = await vision.extractEventsFromText({ text, userId, userTimezone: timezone });
        sourceRef = "selected-text";
      } else {
        throw new HttpError(400, "kind must be 'image' or 'text'");
      }
    } catch (e) {
      if (e instanceof vision.VisionExtractionError) {
        const status = e.code === "too_large" ? 413 : e.code === "bad_media_type" ? 415 : e.code === "content_blocked" ? 422 : 502;
        throw new HttpError(status, e.message);
      }
      throw e;
    }

    let ids: string[] = [];
    if (extraction.events.length) {
      const db = { query: (sql: string, params: unknown[]) => pool().query(sql, params) as Promise<{ rows: Array<{ id: string }> }> };
      ids = await vision.stageForConfirmation(db, userId, extraction, sourceRef);
    }

    return {
      proposals: extraction.events.map((ev, i) => ({
        id: ids[i] ?? null,
        title: ev.title,
        start: ev.start_time,
        end: ev.end_time,
        all_day: ev.all_day,
        location: ev.location,
        needs_review: ev.needs_review,
        assumptions: ev.assumptions,
      })),
      image_type: extraction.image_type,
      legibility: extraction.legibility,
      notes: extraction.notes,
    };
  });

  /* ---- suggestions awaiting a decision ---- */
  r.get("/proposals", async (ctx) => {
    const userId = requireAuth(ctx);
    return { proposals: await listPending(query, userId) };
  });

  r.post("/proposals/:id/confirm", async (ctx) => {
    const userId = requireAuth(ctx);
    // A write to someone's real calendar: cap how fast it can be hammered.
    if (!writeLimiter.hit(userId)) throw new HttpError(429, "Slow down for a moment, then try again.");
    assertUuid(ctx.params.id);
    const out = await confirmProposal(calendarDeps(), userId, ctx.params.id, ctx.body);
    return { ok: true, ...out };
  });

  r.post("/proposals/:id/reject", async (ctx) => {
    const userId = requireAuth(ctx);
    await rejectProposal(query, userId, ctx.params.id);
    return { ok: true };
  });

  /* ---- pull the next week of each connected calendar into the cache ---- */
  r.post("/sync", async (ctx) => {
    const userId = requireAuth(ctx);
    if (!syncLimiter.hit(userId)) throw new HttpError(429, "Synced a moment ago. Try again shortly.");
    return { ok: true, ...(await syncUser(calendarDeps(), userId)) };
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
    if (!agentRunLimiter.hit(userId)) throw new HttpError(429, "That's the limit of assistant runs for this hour. Try again later.");
    await ensureSettings(userId);
    // What the person writes is sent to the model provider, so the AI consent switch applies.
    await requireAiConsent(userId);
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

  /* ---- content-free safety log, called by moderation.ts over loopback only ---- */
  r.post("/safety-events", async (ctx) => {
    assertLoopback(ctx);
    if (ctx.req.headers["x-forwarded-for"]) throw new HttpError(403, "Internal endpoint"); // came through a proxy
    const kind = ctx.body.kind;
    if (kind !== "crisis_intercept" && kind !== "content_block" && kind !== "injection_blocked") {
      throw new HttpError(400, "Unknown kind");
    }
    if (!dbConfigured()) return { ok: true, stored: false };
    await query(
      `insert into safety_events (user_id, kind, detector) values ($1,$2,$3)`,
      [str(ctx.body.user_id, "user_id", 64), kind, str(ctx.body.detector, "detector", 64)]
    );
    return { ok: true, stored: true };
  });

  /* ---- staging only: seed an event so quiet mode can be exercised without a calendar sync ---- */
  if (config.testAccessToken) {
    r.post("/dev/events", async (ctx: Ctx) => {
      const userId = requireAuth(ctx);
      const startsInMinutes = Number(ctx.body.startsInMinutes ?? -5);
      const durationMinutes = Math.min(Math.max(Number(ctx.body.durationMinutes ?? 45), 1), 600);
      const category = ["exam", "class", "meeting", "focus_block", "other"].includes(ctx.body.category as string)
        ? (ctx.body.category as string) : "meeting";
      await ensureSettings(userId);
      const start = new Date(Date.now() + startsInMinutes * 60_000);
      await query(
        `insert into events_cache (user_id, provider, provider_event_id, title, start_time, end_time, category)
         values ($1,'google',$2,$3,$4,$5,$6)`,
        [userId, `dev-${Date.now()}`, String(ctx.body.title ?? "Test event").slice(0, 200),
         start.toISOString(), new Date(start.getTime() + durationMinutes * 60_000).toISOString(), category]
      );
      return { ok: true };
    });
  }

  return r;
}
