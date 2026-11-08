/**
 * Publishing a post to the person's own Bluesky account through the official AT Protocol API.
 *
 *   1. POST com.atproto.server.createSession with the handle and an app password
 *   2. POST com.atproto.repo.createRecord with an app.bsky.feed.post record
 *
 * Only app passwords are accepted (Settings → Privacy and security → App passwords on Bluesky).
 * They can be revoked on their own and cannot change the account's main password, so a leaked
 * one is a nuisance rather than a takeover. The credential is decrypted for the length of one
 * call and never logged. Errors carry a status and a kind, never a response body.
 */
import { ProviderError, type FetchLike } from "../shared.ts";
import { composedPostText } from "./policy.ts";

const ENTRYWAY = "https://bsky.social/xrpc";
const TIMEOUT_MS = 15_000;

/** Bluesky's app-password shape: four groups of four lowercase letters or digits. */
const APP_PASSWORD = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const HANDLE = /^@?([a-z0-9-]+\.)+[a-z0-9-]+$/i;

export interface BlueskyCredential { identifier: string; appPassword: string }
interface Session { did: string; handle: string; accessJwt: string }

export function parseCredential(identifier: unknown, appPassword: unknown): BlueskyCredential {
  const id = typeof identifier === "string" ? identifier.trim().replace(/^@/, "").toLowerCase() : "";
  const pw = typeof appPassword === "string" ? appPassword.trim().toLowerCase() : "";
  if (!HANDLE.test(id) || id.length > 253) throw new ProviderError("rejected", "That doesn't look like a Bluesky handle, e.g. yourname.bsky.social.");
  if (!APP_PASSWORD.test(pw)) {
    throw new ProviderError("rejected", "Use a Bluesky app password (xxxx-xxxx-xxxx-xxxx), not your main password. Create one in Bluesky under Settings → Privacy and security → App passwords.");
  }
  return { identifier: id, appPassword: pw };
}

function classify(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("unauthorized", `Bluesky refused access (${status})`, status);
  if (status === 429) return new ProviderError("unavailable", "Bluesky rate limit reached; try again shortly", status);
  if (status >= 400 && status < 500) return new ProviderError("rejected", `Bluesky rejected the request (${status})`, status);
  return new ProviderError("unavailable", `Bluesky unavailable (${status})`, status);
}

async function xrpc(f: FetchLike, method: string, body: unknown, accessJwt?: string): Promise<any> {
  let res: Response;
  try {
    res = await f(`${ENTRYWAY}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessJwt ? { Authorization: `Bearer ${accessJwt}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("unavailable", "Could not reach Bluesky");
  }
  // createSession answers a wrong password with 401, but also with 400 "AuthenticationRequired".
  if (res.status === 400 && method === "com.atproto.server.createSession") throw classify(401);
  if (!res.ok) throw classify(res.status);
  return res.json();
}

async function session(c: BlueskyCredential, f: FetchLike): Promise<Session> {
  const s = await xrpc(f, "com.atproto.server.createSession", { identifier: c.identifier, password: c.appPassword });
  if (typeof s?.did !== "string" || typeof s?.accessJwt !== "string") throw new ProviderError("unavailable", "Bluesky sent an unexpected reply");
  return { did: s.did, handle: String(s.handle ?? c.identifier), accessJwt: s.accessJwt };
}

/** Confirms the credential works before it is stored. Returns a label for the connection. */
export async function verifyCredential(c: BlueskyCredential, f: FetchLike = fetch): Promise<{ label: string; handle: string }> {
  const s = await session(c, f);
  return { label: `Bluesky (@${s.handle})`, handle: s.handle };
}

/** Byte offsets, because Bluesky facets index UTF-8 bytes rather than characters. */
function linkFacet(text: string, link: string) {
  const at = text.lastIndexOf(link);
  if (at < 0) return [];
  const byteStart = Buffer.byteLength(text.slice(0, at), "utf8");
  return [{
    index: { byteStart, byteEnd: byteStart + Buffer.byteLength(link, "utf8") },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: link }],
  }];
}

export interface PublishedPost { uri: string; url: string }

export async function publishPost(
  c: BlueskyCredential,
  post: { text: string; link: string | null },
  opts: { fetch?: FetchLike; now?: Date } = {},
): Promise<PublishedPost> {
  const f = opts.fetch ?? fetch;
  const s = await session(c, f);
  const text = composedPostText("bluesky", post.text, post.link);
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: (opts.now ?? new Date()).toISOString(),
    ...(post.link ? { facets: linkFacet(text, post.link) } : {}),
  };
  const out = await xrpc(f, "com.atproto.repo.createRecord", { repo: s.did, collection: "app.bsky.feed.post", record }, s.accessJwt);
  const uri = String(out?.uri ?? "");
  const rkey = uri.split("/").pop() ?? "";
  return { uri, url: `https://bsky.app/profile/${s.handle}/post/${rkey}` };
}
