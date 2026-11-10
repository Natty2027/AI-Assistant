/**
 * Request authentication → a Supabase user id (uuid), which every table keys on via
 * auth.uid() in db/schema.sql.
 *
 * Only the Authorization header is read (a cookie fallback would let any website ride the
 * person's session). In order:
 *   1. Bearer TEST_ACCESS_TOKEN                          (staging only, maps to TEST_USER_ID)
 *   2. Bearer <Supabase access token>                    (what the app sends after Sign in with Apple)
 *   3. DEV_USER_ID env                                   (local dev only; refused on Railway)
 *
 * Supabase access tokens are verified with node:crypto and no external dependency: ES256/RS256
 * against the project's published signing keys (from SUPABASE_URL), or HS256 against the legacy
 * SUPABASE_JWT_SECRET for older projects.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";
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
  // Same rules as the asymmetric path: an expiry is required, and only user sessions count.
  checkClaims(claims);
  if (claims.aud !== "authenticated") throw new HttpError(401, "Token is not a user session");
  return claims;
}

/* ---------------- asymmetric signing keys (ES256 / RS256) ----------------
 * New Supabase projects sign access tokens with an asymmetric key and publish the public half at
 * /auth/v1/.well-known/jwks.json. The keys are fetched at boot and every ten minutes, so checking
 * a token stays synchronous; a token signed with a key we haven't seen triggers a refresh and is
 * refused this once (the app refreshes and retries). */

const signingKeys = new Map<string, { key: KeyObject; alg: "ES256" | "RS256" }>();
let refreshing: Promise<void> | null = null;

type Jwk = JsonWebKey & { kid?: string; alg?: string };

/** Replaces the known keys. Exported for tests; refreshSigningKeys is the production path. */
export function setSigningKeys(keys: Jwk[]): void {
  signingKeys.clear();
  for (const jwk of keys) {
    const alg = jwk.alg ?? (jwk.kty === "EC" ? "ES256" : jwk.kty === "RSA" ? "RS256" : undefined);
    if (!jwk.kid || (alg !== "ES256" && alg !== "RS256")) continue;
    try {
      signingKeys.set(jwk.kid, { key: createPublicKey({ key: jwk, format: "jwk" }), alg });
    } catch { /* a malformed key is skipped, not fatal */ }
  }
}

export function refreshSigningKeys(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!config.supabaseUrl) return Promise.resolve();
  refreshing ??= (async () => {
    try {
      const res = await fetchImpl(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const body = (await res.json()) as { keys?: Jwk[] };
        if (Array.isArray(body.keys)) setSigningKeys(body.keys);
      }
    } catch {
      // Keep the keys we have; the next refresh tries again.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function decodeSegment<T>(segment: string, what: string): T {
  try {
    return JSON.parse(b64urlToBuf(segment).toString("utf8")) as T;
  } catch {
    throw new HttpError(401, `Token ${what} unreadable`);
  }
}

function checkClaims(claims: JwtClaims): JwtClaims {
  // A token without an expiry would never expire, so it's refused outright.
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new HttpError(401, "Token expired");
  if (!claims.sub) throw new HttpError(401, "Token has no subject");
  return claims;
}

function verifyAsymmetricJwt(token: string, alg: string, kid: string | undefined): JwtClaims {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  const entry = kid ? signingKeys.get(kid) : undefined;
  if (!entry) {
    void refreshSigningKeys();
    throw new HttpError(401, "Sign-in key not recognised yet. Try again.");
  }
  if (entry.alg !== alg) throw new HttpError(401, "Token algorithm mismatch");
  const ok = verifySignature("sha256", Buffer.from(`${headerB64}.${payloadB64}`),
    entry.alg === "ES256" ? { key: entry.key, dsaEncoding: "ieee-p1363" } : entry.key, b64urlToBuf(sigB64));
  if (!ok) throw new HttpError(401, "Token signature invalid");
  const claims = checkClaims(decodeSegment<JwtClaims>(payloadB64, "payload"));
  // Supabase issues user sessions for the "authenticated" audience from <project>/auth/v1.
  if (claims.aud !== "authenticated") throw new HttpError(401, "Token is not a user session");
  if (config.supabaseUrl && claims.iss !== `${config.supabaseUrl}/auth/v1`) throw new HttpError(401, "Token issuer not recognised");
  return claims;
}

function bearerFrom(ctx: Ctx): string | undefined {
  const h = ctx.req.headers["authorization"];
  // Bearer header only. A cookie fallback would let any website the user visits ride their
  // session (cross-site request forgery); a header can't be added by another site.
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

  if (token && token.split(".").length === 3) {
    const header = decodeSegment<{ alg?: string; kid?: string }>(token.split(".")[0], "header");
    if (header.alg === "HS256" && config.supabaseJwtSecret) {
      ctx.userId = verifyJwt(token, config.supabaseJwtSecret).sub!;
      return ctx.userId;
    }
    if ((header.alg === "ES256" || header.alg === "RS256") && (config.supabaseUrl || signingKeys.size)) {
      ctx.userId = verifyAsymmetricJwt(token, header.alg, header.kid).sub!;
      return ctx.userId;
    }
    // Anything else ("none", an algorithm we don't verify) is never trusted.
    if (!config.devUserId) throw new HttpError(401, "Token type not accepted");
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
