/**
 * Sign-in with a platform (X, Meta) using the OAuth authorization-code flow.
 *
 *   1. The app asks the server to start: the server makes a random `state` and a PKCE verifier,
 *      remembers them for this person, and returns the platform's sign-in address.
 *   2. The person signs in on the platform's own page (the app shows it in a secure browser
 *      sheet; the app never sees the password).
 *   3. The platform sends the browser back to <publicUrl>/oauth/callback/<provider> with a code
 *      and the same state. The state finds the person; it is single-use and expires in ten
 *      minutes, so a stolen or replayed callback is useless.
 *   4. The server trades the code for tokens and holds the result for a few minutes under a
 *      one-time id, then sends the browser on to hera://connected?pending=<id>, which closes the
 *      sheet in the app.
 *   5. The app, signed in as the person, confirms that id. Only then is the connection saved, and
 *      only if it's the same person who started. Without this step, someone could start a sign-in,
 *      send the link to a victim, and have the victim's account attached to their own Hera.
 *
 * Pending sign-ins live in memory: fine for one server instance (an unfinished sign-in is simply
 * started again after a restart). Move them to the database before scaling out.
 */
import { createHash, randomBytes } from "node:crypto";

export const OAUTH_PROVIDERS = ["x", "meta"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(p: unknown): p is OAuthProvider {
  return typeof p === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(p);
}

/** PKCE S256: what the platform is shown at the start, so only this server can finish. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Where the platform sends the browser back to. Must match the developer app's settings exactly. */
export function redirectUri(publicUrl: string, provider: OAuthProvider): string {
  return `${publicUrl}/oauth/callback/${provider}`;
}

/** Where the server sends the browser when it's done; the app's sign-in sheet closes on it. A
 *  success can carry a note, for something the person should know (e.g. Instagram wasn't linked). */
export function appReturnUrl(provider: OAuthProvider, outcome: { ok: true; pending: string } | { ok: false; message: string }): string {
  const q = new URLSearchParams({ provider, status: outcome.ok ? "ok" : "error" });
  if (outcome.ok) q.set("pending", outcome.pending);
  else q.set("message", outcome.message);
  return `hera://connected?${q}`;
}

/**
 * Sign-ins that finished at the platform but aren't saved yet: the app must confirm them, signed
 * in as the same person who started (see step 5 above). Single use, five minutes.
 */
export class PendingConnections<T> {
  private items = new Map<string, { userId: string; provider: OAuthProvider; value: T; expires: number }>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  hold(userId: string, provider: OAuthProvider, value: T): string {
    const now = this.clock();
    for (const [k, v] of this.items) if (v.expires < now) this.items.delete(k);
    const id = randomBytes(24).toString("base64url");
    this.items.set(id, { userId, provider, value, expires: now + 5 * 60_000 });
    return id;
  }

  /** The held result, if it exists, hasn't expired, and belongs to `userId`. Gone afterwards
   *  either way, so a guessed or stolen id is useless after one try. */
  take(id: string, userId: string): { provider: OAuthProvider; value: T } | null {
    const item = this.items.get(id);
    this.items.delete(id);
    if (!item || item.userId !== userId || item.expires < this.clock()) return null;
    return { provider: item.provider, value: item.value };
  }

  forget(userId: string): void {
    for (const [k, v] of this.items) if (v.userId === userId) this.items.delete(k);
  }
}

interface Pending { userId: string; provider: OAuthProvider; verifier: string; expires: number }

const TTL_MS = 10 * 60_000;

export class OAuthStates {
  private pending = new Map<string, Pending>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  begin(userId: string, provider: OAuthProvider): { state: string; verifier: string; challenge: string } {
    this.sweep();
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, { userId, provider, verifier, expires: this.clock() + TTL_MS });
    return { state, verifier, challenge: pkceChallenge(verifier) };
  }

  /** Single use: the state is gone after this, whether or not it was valid. */
  finish(state: string, provider: OAuthProvider): { userId: string; verifier: string } | null {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.provider !== provider || p.expires < this.clock()) return null;
    return { userId: p.userId, verifier: p.verifier };
  }

  /** Account deletion. */
  forget(userId: string): void {
    for (const [k, v] of this.pending) if (v.userId === userId) this.pending.delete(k);
  }

  private sweep(): void {
    const now = this.clock();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
  }
}
