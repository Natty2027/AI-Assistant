/**
 * Posting to the person's Facebook Page and its linked Instagram professional account through
 * Meta's Graph API. One "Continue with Facebook" sign-in covers both.
 *
 *   sign-in   https://www.facebook.com/<v>/dialog/oauth  ->  GET /oauth/access_token
 *             then a long-lived user token (fb_exchange_token), whose Page tokens don't expire
 *   pages     GET  /me/accounts  (each Page, its token, and its linked Instagram account)
 *   Facebook  POST /{page}/feed  (text and link)  or  POST /{page}/photos  (with a photo)
 *   Instagram POST /{ig}/media  ->  wait until FINISHED  ->  POST /{ig}/media_publish
 *
 * Meta's rules: only Pages (not personal profiles) and Instagram business or creator accounts
 * linked to a Page can be posted to, and an Instagram post needs a photo at a public https
 * address, which Meta downloads itself. Errors carry a status and a kind, never a response body.
 */
import { ProviderError, type FetchLike } from "../shared.ts";
import type { OAuthClient } from "../config.ts";

const VERSION = "v23.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const DIALOG = `https://www.facebook.com/${VERSION}/dialog/oauth`;
const TIMEOUT_MS = 20_000;
export const META_SCOPES = [
  "pages_show_list", "pages_manage_posts", "pages_read_engagement",
  "instagram_basic", "instagram_content_publish", "business_management",
];

/** One Page the person manages, with the Instagram account linked to it, if any. */
export interface MetaPage { id: string; name: string; token: string; instagram: { id: string; username: string } | null }
/** What is stored per connection: the Page token works for the Page and its Instagram account. */
export interface MetaCredential { pageToken: string }

export function authorizeUrl(client: OAuthClient, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: client.clientId, redirect_uri: redirectUri, state,
    response_type: "code", scope: META_SCOPES.join(","),
  });
  return `${DIALOG}?${q}`;
}

/** Graph errors: code 190 (and 102) mean the token is no longer valid. */
async function classify(res: Response): Promise<ProviderError> {
  let code: number | undefined;
  try { code = (await res.json())?.error?.code; } catch { /* no JSON body */ }
  if (code === 190 || code === 102 || res.status === 401) return new ProviderError("unauthorized", `Meta refused access (${res.status})`, res.status);
  if (code === 4 || code === 17 || code === 32 || code === 613 || res.status === 429) {
    return new ProviderError("unavailable", "Meta rate limit reached; try again later", res.status);
  }
  if (res.status >= 400 && res.status < 500) return new ProviderError("rejected", `Meta rejected the request (${res.status})`, res.status);
  return new ProviderError("unavailable", `Meta unavailable (${res.status})`, res.status);
}

async function graph(f: FetchLike, path: string, opts: { query?: Record<string, string>; form?: Record<string, string> } = {}): Promise<any> {
  const url = `${GRAPH}${path}${opts.query ? `?${new URLSearchParams(opts.query)}` : ""}`;
  let res: Response;
  try {
    res = await f(url, opts.form
      ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(opts.form).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) }
      : { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("unavailable", "Could not reach Meta");
  }
  if (!res.ok) throw await classify(res);
  return res.json();
}

/** Finishes sign-in: code -> user token -> long-lived user token -> the Pages and their tokens. */
export async function exchangeCode(client: OAuthClient, code: string, redirectUri: string, f: FetchLike = fetch): Promise<MetaPage[]> {
  const secret = { client_id: client.clientId, client_secret: client.clientSecret };
  let short: any;
  try {
    short = await graph(f, "/oauth/access_token", { query: { ...secret, redirect_uri: redirectUri, code } });
  } catch (e) {
    // A used or expired code is a 400: the person must sign in again.
    if (e instanceof ProviderError && e.kind === "rejected") throw new ProviderError("unauthorized", "Meta didn't accept the sign-in", e.status);
    throw e;
  }
  if (typeof short?.access_token !== "string") throw new ProviderError("unavailable", "Meta sent an unexpected reply");
  const long = await graph(f, "/oauth/access_token", { query: { ...secret, grant_type: "fb_exchange_token", fb_exchange_token: short.access_token } });
  const userToken = typeof long?.access_token === "string" ? long.access_token : short.access_token;

  const pages = await graph(f, "/me/accounts", {
    query: { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100", access_token: userToken },
  });
  const list: any[] = Array.isArray(pages?.data) ? pages.data : [];
  return list
    .filter((p) => typeof p?.id === "string" && typeof p?.access_token === "string")
    .map((p) => ({
      id: p.id, name: String(p.name ?? "Facebook Page"), token: p.access_token,
      instagram: typeof p.instagram_business_account?.id === "string"
        ? { id: p.instagram_business_account.id, username: String(p.instagram_business_account.username ?? "") }
        : null,
    }));
}

const postUrl = (id: string) => `https://www.facebook.com/${id}`;

/** A post on the Page: text and link, or text with one photo at a public https address. */
export async function publishFacebook(
  c: MetaCredential, pageId: string, post: { text: string; link: string | null; imageUrl: string | null }, f: FetchLike = fetch,
): Promise<{ id: string; url: string }> {
  if (post.imageUrl) {
    // A photo post has no separate link field, so the link goes in the text.
    const message = post.link && !post.text.includes(post.link) ? `${post.text}\n\n${post.link}` : post.text;
    const out = await graph(f, `/${pageId}/photos`, { form: { url: post.imageUrl, message, access_token: c.pageToken } });
    const id = String(out?.post_id ?? out?.id ?? "");
    if (!id) throw new ProviderError("unavailable", "Meta sent an unexpected reply");
    return { id, url: postUrl(id) };
  }
  const out = await graph(f, `/${pageId}/feed`, {
    form: { message: post.text, ...(post.link ? { link: post.link } : {}), access_token: c.pageToken },
  });
  const id = String(out?.id ?? "");
  if (!id) throw new ProviderError("unavailable", "Meta sent an unexpected reply");
  return { id, url: postUrl(id) };
}

/** An Instagram feed post with one photo. Meta downloads the photo, then it is published. */
export async function publishInstagram(
  c: MetaCredential, igId: string, post: { caption: string; imageUrl: string },
  opts: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ id: string; url: string }> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const container = await graph(f, `/${igId}/media`, { form: { image_url: post.imageUrl, caption: post.caption, access_token: c.pageToken } });
  const creationId = String(container?.id ?? "");
  if (!creationId) throw new ProviderError("unavailable", "Meta sent an unexpected reply");

  // Usually ready at once; give Meta up to about 30 seconds to fetch and check the photo.
  for (let attempt = 0; ; attempt++) {
    const s = await graph(f, `/${creationId}`, { query: { fields: "status_code", access_token: c.pageToken } });
    if (s?.status_code === "FINISHED") break;
    if (s?.status_code === "ERROR" || s?.status_code === "EXPIRED") {
      throw new ProviderError("rejected", "Instagram couldn't use that photo. Use a JPEG photo that isn't too tall or too wide.");
    }
    if (attempt >= 10) throw new ProviderError("unavailable", "Instagram is still processing the photo; try again shortly");
    await sleep(3000);
  }

  const published = await graph(f, `/${igId}/media_publish`, { form: { creation_id: creationId, access_token: c.pageToken } });
  const id = String(published?.id ?? "");
  if (!id) throw new ProviderError("unavailable", "Meta sent an unexpected reply");
  let url = `https://www.instagram.com/`;
  try {
    const m = await graph(f, `/${id}`, { query: { fields: "permalink", access_token: c.pageToken } });
    if (typeof m?.permalink === "string") url = m.permalink;
  } catch {
    // Posted either way; the link is a nicety.
  }
  return { id, url };
}
