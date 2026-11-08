/**
 * Publishing a static site to the person's own Netlify account.
 *
 * Uses Netlify's documented "file digest" deploy (docs.netlify.com, Get started with the API):
 *   1. POST /sites/{site_id}/deploys with { files: { "/path": sha1 } }
 *   2. Netlify replies with the SHA1s it does not already have (`required`)
 *   3. PUT /deploys/{deploy_id}/files/{path} with the raw bytes of each required file
 *   4. poll the deploy until its state is "ready" (or "error")
 *
 * The person connects with their own personal access token, so hosting is on their account and
 * their bill. The token is used only here, decrypted for the length of one call, never logged.
 * Errors carry a status and a kind, never a response body, which can echo request data.
 */
import { createHash } from "node:crypto";
import { ProviderError, type FetchLike } from "../calendar.ts";

const API = "https://api.netlify.com/api/v1";
const TIMEOUT_MS = 25_000; // Netlify ends requests that run longer than 30 seconds

interface NetlifySite { id: string; ssl_url?: string; url?: string; admin_url?: string }

export interface PublishedSite { siteId: string; url: string; adminUrl: string | null; deployId: string }

function classify(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("unauthorized", `Netlify refused access (${status})`, status);
  if (status === 404) return new ProviderError("rejected", "Netlify could not find that site", status);
  if (status === 429) return new ProviderError("unavailable", "Netlify rate limit reached; try again shortly", status);
  if (status >= 400 && status < 500) return new ProviderError("rejected", `Netlify rejected the request (${status})`, status);
  return new ProviderError("unavailable", `Netlify unavailable (${status})`, status);
}

async function call(f: FetchLike, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await f(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("unavailable", "Could not reach Netlify");
  }
  if (!res.ok) throw classify(res.status);
  return res;
}

/** Confirms a token works before it is stored. Returns a label for the connection. */
export async function verifyToken(token: string, f: FetchLike = fetch): Promise<{ label: string }> {
  const user = (await (await call(f, token, "/user")).json()) as { email?: string; full_name?: string };
  return { label: user.email ? `Netlify (${user.email})` : "Netlify" };
}

/** Each path segment escaped; Netlify asks that paths contain no `#` or `?`. */
export function encodeFilePath(p: string): string {
  if (/[#?]/.test(p)) throw new ProviderError("rejected", "File names may not contain # or ?");
  return p.split("/").map(encodeURIComponent).join("/");
}

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

export async function publish(
  token: string,
  files: Array<{ path: string; contents: string }>,
  existingSiteId: string | null,
  opts: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; maxPolls?: number } = {},
): Promise<PublishedSite> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxPolls = opts.maxPolls ?? 20;

  // Reuse the site this connection published before, so the address stays the same.
  let site: NetlifySite | null = null;
  if (existingSiteId) {
    try {
      site = await (await call(f, token, `/sites/${encodeURIComponent(existingSiteId)}`)).json() as NetlifySite;
    } catch (e) {
      // Deleted on Netlify's side: make a new one rather than failing the person's publish.
      if (!(e instanceof ProviderError && e.status === 404)) throw e;
    }
  }
  if (!site) {
    site = await (await call(f, token, "/sites", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).json() as NetlifySite;
  }
  if (!site?.id) throw new ProviderError("unavailable", "Netlify did not return a site");

  const digests: Record<string, string> = {};
  const bySha = new Map<string, { path: string; contents: string }>();
  for (const file of files) {
    const d = sha1(file.contents);
    digests[`/${file.path}`] = d;
    bySha.set(d, file);
  }

  const deploy = await (await call(f, token, `/sites/${encodeURIComponent(site.id)}/deploys`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: digests }),
  })).json() as { id?: string; required?: string[] };
  if (!deploy.id) throw new ProviderError("unavailable", "Netlify did not start a deploy");

  // Upload only what Netlify does not already have.
  for (const d of deploy.required ?? []) {
    const file = bySha.get(d);
    if (!file) throw new ProviderError("unavailable", "Netlify asked for a file that is not part of this site");
    await call(f, token, `/deploys/${encodeURIComponent(deploy.id)}/files/${encodeFilePath(file.path)}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(file.contents, "utf8"),
    });
  }

  for (let i = 0; i < maxPolls; i++) {
    const state = await (await call(f, token, `/sites/${encodeURIComponent(site.id)}/deploys/${encodeURIComponent(deploy.id)}`)).json() as
      { state?: string; ssl_url?: string; deploy_ssl_url?: string; error_message?: string };
    if (state.state === "ready") {
      return { siteId: site.id, url: state.ssl_url ?? site.ssl_url ?? state.deploy_ssl_url ?? site.url ?? "", adminUrl: site.admin_url ?? null, deployId: deploy.id };
    }
    if (state.state === "error" || state.state === "rejected") {
      throw new ProviderError("rejected", "Netlify could not publish this site");
    }
    await sleep(1500);
  }
  throw new ProviderError("unavailable", "Netlify is still processing the site; check your Netlify dashboard");
}
