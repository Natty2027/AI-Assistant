/**
 * Posting to the person's own X account through the official X API v2, with OAuth 2.0
 * (authorization code + PKCE). The person signs in on x.com; this server never sees their
 * password, only tokens limited to the scopes below, stored encrypted.
 *
 *   sign-in   https://x.com/i/oauth2/authorize  ->  POST /2/oauth2/token
 *   who       GET  /2/users/me
 *   post      POST /2/tweets
 *
 * Access tokens last two hours; the refresh token (offline.access) gets a new one, and X replaces
 * the refresh token every time it is used, so the caller must save the credential it gets back.
 * Errors carry a status and a kind, never a response body.
 */
import { ProviderError, type FetchLike } from "../shared.ts";
import type { OAuthClient } from "../config.ts";
import { composedPostText } from "./policy.ts";

const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const API = "https://api.x.com/2";
const TIMEOUT_MS = 15_000;
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"];

export interface XCredential { accessToken: string; refreshToken: string; expiresAt: number; username: string }

export function authorizeUrl(client: OAuthClient, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: "code", client_id: client.clientId, redirect_uri: redirectUri,
    scope: X_SCOPES.join(" "), state, code_challenge: challenge, code_challenge_method: "S256",
  });
  return `${AUTHORIZE}?${q}`;
}

function classify(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("unauthorized", `X refused access (${status})`, status);
  if (status === 429) return new ProviderError("unavailable", "X rate limit reached; try again later", status);
  if (status >= 400 && status < 500) return new ProviderError("rejected", `X rejected the request (${status})`, status);
  return new ProviderError("unavailable", `X unavailable (${status})`, status);
}

async function call(f: FetchLike, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("unavailable", "Could not reach X");
  }
  if (!res.ok) throw classify(res.status);
  return res.json();
}

/** The token endpoint: a confidential client authenticates with Basic auth. */
async function token(client: OAuthClient, body: Record<string, string>, f: FetchLike): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64");
  let out: any;
  try {
    out = await call(f, `${API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ ...body, client_id: client.clientId }).toString(),
    });
  } catch (e) {
    // A used, expired or revoked code or refresh token is a 400 here: the person must sign in again.
    if (e instanceof ProviderError && e.status === 400) throw new ProviderError("unauthorized", "X didn't accept the sign-in", 400);
    throw e;
  }
  if (typeof out?.access_token !== "string" || typeof out?.refresh_token !== "string") {
    throw new ProviderError("unavailable", "X sent an unexpected reply");
  }
  return { accessToken: out.access_token, refreshToken: out.refresh_token, expiresAt: Date.now() + Number(out.expires_in ?? 7200) * 1000 };
}

/** Finishes sign-in: trades the code for tokens and finds out whose account it is. */
export async function exchangeCode(
  client: OAuthClient, code: string, verifier: string, redirectUri: string, f: FetchLike = fetch,
): Promise<XCredential> {
  const t = await token(client, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, f);
  const me = await call(f, `${API}/users/me`, { headers: { Authorization: `Bearer ${t.accessToken}` } });
  const username = me?.data?.username;
  if (typeof username !== "string" || !username) throw new ProviderError("unavailable", "X sent an unexpected reply");
  return { ...t, username };
}

/** The credential, refreshed first if its access token is about to run out. */
export async function freshCredential(client: OAuthClient, c: XCredential, f: FetchLike = fetch, now = Date.now()): Promise<XCredential> {
  if (c.expiresAt - 60_000 > now) return c;
  const t = await token(client, { grant_type: "refresh_token", refresh_token: c.refreshToken }, f);
  return { ...t, username: c.username };
}

export async function publishPost(
  c: XCredential, post: { text: string; link: string | null }, f: FetchLike = fetch,
): Promise<{ id: string; url: string }> {
  const out = await call(f, `${API}/tweets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.accessToken}` },
    body: JSON.stringify({ text: composedPostText("x", post.text, post.link) }),
  });
  const id = String(out?.data?.id ?? "");
  if (!id) throw new ProviderError("unavailable", "X sent an unexpected reply");
  return { id, url: `https://x.com/${c.username}/status/${id}` };
}
