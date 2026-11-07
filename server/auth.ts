/**
 * Request authentication → a Supabase user id (uuid), which every table keys on via
 * auth.uid() in db/schema.sql.
 *
 * Three sources, in order:
 *   1. Authorization: Bearer <supabase access token>   (preferred; extension should send this)
 *   2. Cookie: sb-access-token=<...>                     (credentials:"include" from the panel)
 *   3. DEV_USER_ID env                                   (local dev only, no token required)
 *
 * Supabase signs access tokens as HS256 JWTs with the project's JWT secret, so we can verify
 * them with node:crypto and no external dependency. If SUPABASE_JWT_SECRET is unset we fall
 * back to DEV_USER_ID so the server is usable before Supabase is wired up.
 *
 * NOTE (integration gap, documented in server/README.md): src/sw.ts currently calls the API
 * with credentials:"include" but does not attach an Authorization header. Until it does, set
 * DEV_USER_ID locally, or add the header in sw.ts. This is the one client change the backend
 * needs and it is intentionally called out rather than hidden.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { HttpError, type Ctx } from "./http.ts";
import { clientIp, createLimiter } from "./rateLimit.ts";

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface JwtClaims {
  sub?: string;
  exp?: number;
  [k: string]: unknown;
}

/** Verify an HS256 Supabase JWT and return its claims, or throw. */
function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Malformed token");
  const [headerB64, payloadB64, sigB64] = parts;

  const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  const provided = b64urlToBuf(sigB64);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new HttpError(401, "Token signature invalid");
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(b64urlToBuf(payloadB64).toString("utf8"));
  } catch {
    throw new HttpError(401, "Token payload unreadable");
  }
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new HttpError(401, "Token expired");
  if (!claims.sub) throw new HttpError(401, "Token has no subject");
  return claims;
}

function bearerFrom(ctx: Ctx): string | undefined {
  const h = ctx.req.headers["authorization"];
  // Bearer header only. A cookie fallback would let any website the user visits ride their
  // session, which is exactly what the credentialed-CORS hole elsewhere would have enabled.
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return undefined;
}

/**
 * Resolve and attach ctx.userId, or throw 401. Call at the top of every authenticated route.
 * Returns the id for convenience.
 */
export function requireAuth(ctx: Ctx): string {
  const ip = clientIp(ctx.req);
  if (authFailures.blocked(ip)) {
    throw new HttpError(429, "Too many failed sign-in attempts. Try again in a few minutes.");
  }
  try {
    return resolveUser(ctx);
  } catch (e) {
    // The test token is a single shared secret, so guessing it must be expensive.
    if (e instanceof HttpError && e.status === 401) authFailures.hit(ip);
    throw e;
  }
}

/** 20 failed attempts per 15 minutes per address. */
const authFailures = createLimiter({ windowMs: 15 * 60_000, max: 20 });

function resolveUser(ctx: Ctx): string {
  const token = bearerFrom(ctx);

  // Staging path: a shared secret standing in for sign-in. Constant-time compare.
  if (token && config.testAccessToken && config.testUserId) {
    const a = Buffer.from(token);
    const b = Buffer.from(config.testAccessToken);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      ctx.userId = config.testUserId;
      return ctx.userId;
    }
  }

  if (token && config.supabaseJwtSecret && token.split(".").length === 3) {
    const claims = verifyJwt(token, config.supabaseJwtSecret);
    ctx.userId = claims.sub!;
    return ctx.userId;
  }

  if (config.devUserId) {
    ctx.userId = config.devUserId;
    return ctx.userId;
  }

  throw new HttpError(
    401,
    "Not signed in. Send a Supabase access token as 'Authorization: Bearer …', or set DEV_USER_ID for local testing."
  );
}

/** For internal endpoints (e.g. /safety-events) that trust the loopback origin only. */
export function assertLoopback(ctx: Ctx): void {
  const ra = ctx.req.socket.remoteAddress ?? "";
  const isLocal = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
  if (!isLocal) throw new HttpError(403, "Internal endpoint");
}
