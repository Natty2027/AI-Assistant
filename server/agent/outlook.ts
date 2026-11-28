/**
 * The person's own Outlook mailbox, through Microsoft Graph, with the Microsoft identity
 * platform's OAuth 2.0 authorization-code flow (PKCE, confidential client). Tenant "common", so
 * both work or school accounts and personal Microsoft accounts (Outlook.com, Hotmail) can sign in.
 * The person signs in on Microsoft's own page; this server never sees their password, only tokens
 * limited to the scopes below, stored encrypted.
 *
 *   sign-in   login.microsoftonline.com/common/oauth2/v2.0/authorize  ->  .../token
 *   who       GET  /me
 *   send      POST /me/sendMail                       (only an email the person approved)
 *   read      GET  /me/mailFolders/inbox/messages     (only if the person turned reading on)
 *             GET  /me/messages/{id}
 *
 * Access tokens last about an hour; the refresh token (offline_access) gets a new one, and
 * Microsoft may hand back a new refresh token each time, so the caller must save the credential it
 * gets back. Errors carry a status and a kind, never a response body.
 */
import { ProviderError, type FetchLike } from "../shared.ts";
import type { OAuthClient } from "../config.ts";

const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 15_000;
export const OUTLOOK_SCOPES = ["offline_access", "User.Read", "Mail.Send", "Mail.Read"];

export interface OutlookCredential {
  accessToken: string; refreshToken: string; expiresAt: number;
  /** The Graph user id: stays the same if the address changes. */
  accountId: string;
  /** The account's address, shown as the connection's name. */
  email: string;
}

/** An email as Graph sends it: recipients are always ones the person approved. */
export interface OutgoingEmail {
  to: string[]; cc: string[]; subject: string; body: string;
  /** A calendar invite (.ics), attached as a file. */
  invite: { fileName: string; ics: string } | null;
}

/** One message in the inbox list. Everything here was written by someone else. */
export interface InboxMessage { id: string; from: string; subject: string; received: string; preview: string }

const PREVIEW_CHARS = 200;
export const BODY_CHARS = 4000;

export function authorizeUrl(client: OAuthClient, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: client.clientId, response_type: "code", redirect_uri: redirectUri, response_mode: "query",
    scope: OUTLOOK_SCOPES.join(" "), state, code_challenge: challenge, code_challenge_method: "S256",
    // Always ask which account: someone with a work and a personal account picks the right one.
    prompt: "select_account",
  });
  return `${LOGIN}/authorize?${q}`;
}

function classify(status: number): ProviderError {
  if (status === 401) return new ProviderError("unauthorized", `Outlook refused access (${status})`, status);
  if (status === 403) return new ProviderError("rejected", "Outlook didn't allow this (403). The account may not have a mailbox Hera can use.", status);
  if (status === 404) return new ProviderError("rejected", "Outlook couldn't find that (404)", status);
  if (status === 429) return new ProviderError("unavailable", "Outlook is busy; try again in a minute", status);
  if (status >= 400 && status < 500) return new ProviderError("rejected", `Outlook rejected the request (${status})`, status);
  return new ProviderError("unavailable", `Outlook unavailable (${status})`, status);
}

async function call(f: FetchLike, url: string, init: RequestInit, opts: { empty?: boolean } = {}): Promise<any> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("unavailable", "Could not reach Outlook");
  }
  if (!res.ok) throw classify(res.status);
  // sendMail answers 202 with no body.
  return opts.empty ? null : res.json();
}

/** The token endpoint: a confidential client sends its secret in the form body. */
async function token(client: OAuthClient, body: Record<string, string>, f: FetchLike): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number }> {
  let out: any;
  try {
    out = await call(f, `${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, client_id: client.clientId, client_secret: client.clientSecret, scope: OUTLOOK_SCOPES.join(" ") }).toString(),
    });
  } catch (e) {
    // A used, expired or revoked code or refresh token (invalid_grant) is a 400: sign in again.
    if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) throw new ProviderError("unauthorized", "Microsoft didn't accept the sign-in", e.status);
    throw e;
  }
  if (typeof out?.access_token !== "string") throw new ProviderError("unavailable", "Microsoft sent an unexpected reply");
  return {
    accessToken: out.access_token,
    refreshToken: typeof out.refresh_token === "string" ? out.refresh_token : null,
    expiresAt: Date.now() + Number(out.expires_in ?? 3600) * 1000,
  };
}

const bearer = (c: { accessToken: string }) => ({ Authorization: `Bearer ${c.accessToken}` });

/** Finishes sign-in: trades the code for tokens and finds out whose mailbox it is. */
export async function exchangeCode(
  client: OAuthClient, code: string, verifier: string, redirectUri: string, f: FetchLike = fetch,
): Promise<OutlookCredential> {
  const t = await token(client, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }, f);
  if (!t.refreshToken) throw new ProviderError("unavailable", "Microsoft sent an unexpected reply");
  const me = await call(f, `${GRAPH}/me?$select=id,mail,userPrincipalName`, { headers: bearer(t) });
  const accountId = typeof me?.id === "string" ? me.id : "";
  // Personal accounts often have no `mail`; their sign-in name is the address.
  const email = [me?.mail, me?.userPrincipalName].find((v) => typeof v === "string" && v.includes("@")) as string | undefined;
  if (!accountId || !email) throw new ProviderError("unavailable", "Microsoft sent an unexpected reply");
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, accountId, email };
}

/** The credential, refreshed first if its access token is about to run out. */
export async function freshCredential(client: OAuthClient, c: OutlookCredential, f: FetchLike = fetch, now = Date.now()): Promise<OutlookCredential> {
  if (c.expiresAt - 60_000 > now) return c;
  const t = await token(client, { grant_type: "refresh_token", refresh_token: c.refreshToken }, f);
  return { ...c, accessToken: t.accessToken, refreshToken: t.refreshToken ?? c.refreshToken, expiresAt: t.expiresAt };
}

/** The Graph message for an approved email: plain text, the person's recipients, no Bcc. */
export function graphMessage(m: OutgoingEmail): Record<string, unknown> {
  const people = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));
  return {
    subject: m.subject,
    body: { contentType: "Text", content: m.body },
    toRecipients: people(m.to),
    ccRecipients: people(m.cc),
    ...(m.invite ? { attachments: [{
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: m.invite.fileName, contentType: "text/calendar",
      contentBytes: Buffer.from(m.invite.ics, "utf8").toString("base64"),
    }] } : {}),
  };
}

/** Sends from the person's own mailbox; a copy goes to their Sent Items. */
export async function sendMail(c: OutlookCredential, m: OutgoingEmail, f: FetchLike = fetch): Promise<void> {
  await call(f, `${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(c) },
    body: JSON.stringify({ message: graphMessage(m), saveToSentItems: true }),
  }, { empty: true });
}

/** Text from someone else, tidied: no control characters, runs of blank space collapsed. */
function clean(s: unknown, max: number): string {
  const t = String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*(\n\s*)+/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function sender(m: any): string {
  const a = m?.from?.emailAddress;
  const name = clean(a?.name, 100), address = clean(a?.address, 254);
  return name && address && name !== address ? `${name} <${address}>` : address || name || "(unknown sender)";
}

/** The latest messages in the inbox, newest first. */
export async function latestMessages(c: OutlookCredential, f: FetchLike = fetch, count = 10): Promise<InboxMessage[]> {
  const q = new URLSearchParams({ $top: String(count), $select: "id,subject,from,receivedDateTime,bodyPreview", $orderby: "receivedDateTime desc" });
  const out = await call(f, `${GRAPH}/me/mailFolders/inbox/messages?${q}`, { headers: bearer(c) });
  const list: any[] = Array.isArray(out?.value) ? out.value : [];
  return list.filter((m) => typeof m?.id === "string").map((m) => ({
    id: m.id, from: sender(m), subject: clean(m.subject, 300) || "(no subject)",
    received: String(m.receivedDateTime ?? ""), preview: clean(m.bodyPreview, PREVIEW_CHARS),
  }));
}

/** Graph message ids: base64-like, so letters, digits and = + / - _ only. */
export const MESSAGE_ID = /^[A-Za-z0-9=+/_-]{1,512}$/;

/** One message, its body as plain text, trimmed. */
export async function readMessage(c: OutlookCredential, id: string, f: FetchLike = fetch): Promise<InboxMessage & { body: string }> {
  if (!MESSAGE_ID.test(id)) throw new ProviderError("rejected", "That isn't an Outlook message id");
  const q = new URLSearchParams({ $select: "id,subject,from,receivedDateTime,bodyPreview,body" });
  const m = await call(f, `${GRAPH}/me/messages/${encodeURIComponent(id)}?${q}`, {
    // Graph converts an HTML body to text itself, so no HTML (or hidden markup) reaches the model.
    headers: { ...bearer(c), Prefer: 'outlook.body-content-type="text"' },
  });
  return {
    id, from: sender(m), subject: clean(m?.subject, 300) || "(no subject)", received: String(m?.receivedDateTime ?? ""),
    preview: clean(m?.bodyPreview, PREVIEW_CHARS), body: clean(m?.body?.content, BODY_CHARS),
  };
}
