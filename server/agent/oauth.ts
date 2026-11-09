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
 *   4. The server trades the code for tokens, stores them encrypted, and sends the browser on to
 *      hera://connected, which closes the sheet in the app.
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
export function appReturnUrl(provider: OAuthProvider, outcome: { ok: true; note?: string } | { ok: false; message: string }): string {
  const q = new URLSearchParams({ provider, status: outcome.ok ? "ok" : "error" });
  if (!outcome.ok) q.set("message", outcome.message);
  else if (outcome.note) q.set("message", outcome.note);
  return `hera://connected?${q}`;
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
