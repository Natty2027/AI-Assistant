/**
 * The Netlify connector (server/agent/netlify.ts) against a fake Netlify that behaves like the
 * documented API: digest deploys, upload of only the required files, polling until ready.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publish, verifyToken, encodeFilePath } from "../server/agent/netlify.ts";
import { ProviderError, type FetchLike } from "../server/shared.ts";

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Call { method: string; path: string; auth: string | null; body: string | null; contentType: string | null }

/** A fake Netlify. `have` is the set of SHA1s it already stores; `states` is what polling returns. */
function fakeNetlify(opts: { have?: string[]; states?: string[]; existing?: string[]; status?: Partial<Record<string, number>> } = {}) {
  const calls: Call[] = [];
  const have = new Set(opts.have ?? []);
  const states = [...(opts.states ?? ["ready"])];
  const sites = new Set(opts.existing ?? []);
  const f: FetchLike = async (url, init) => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers as HeadersInit);
    const body = init?.body == null ? null : Buffer.isBuffer(init.body) ? (init.body as Buffer).toString("utf8") : String(init.body);
    calls.push({ method, path, auth: headers.get("authorization"), body, contentType: headers.get("content-type") });
    const forced = opts.status?.[`${method} ${path.split("/").slice(0, 2).join("/")}`];
    if (forced) return json({ error: "secret echo of the request" }, forced);

    if (method === "GET" && path === "/user") return json({ id: "u1", email: "owner@example.com" });
    if (method === "POST" && path === "/sites") { sites.add("new-site"); return json({ id: "new-site", ssl_url: "https://new-site.netlify.app", admin_url: "https://app.netlify.com/sites/new-site" }); }
    let m = path.match(/^\/sites\/([^/]+)$/);
    if (m && method === "GET") return sites.has(m[1]) ? json({ id: m[1], ssl_url: `https://${m[1]}.netlify.app` }) : json({}, 404);
    m = path.match(/^\/sites\/([^/]+)\/deploys$/);
    if (m && method === "POST") {
      const files = JSON.parse(body!).files as Record<string, string>;
      return json({ id: "dep-1", required: [...new Set(Object.values(files))].filter((d) => !have.has(d)) });
    }
    m = path.match(/^\/deploys\/dep-1\/files\/(.+)$/);
    if (m && method === "PUT") return json({ ok: true });
    m = path.match(/^\/sites\/([^/]+)\/deploys\/dep-1$/);
    if (m && method === "GET") return json({ state: states.length > 1 ? states.shift() : states[0], ssl_url: `https://${m[1]}.netlify.app` });
    return json({}, 404);
  };
  return { f, calls };
}

const FILES = [
  { path: "index.html", contents: "<h1>Clay Corner</h1>" },
  { path: "css/site.css", contents: "h1{color:#7a4}" },
  { path: "about us.html", contents: "<p>About</p>" },
];
const noSleep = async () => {};

test("a valid token is accepted and labelled with the account email", async () => {
  const { f, calls } = fakeNetlify();
  assert.deepEqual(await verifyToken("tok-abc", f), { label: "Netlify (owner@example.com)" });
  assert.equal(calls[0].auth, "Bearer tok-abc");
});

test("a rejected token is 'unauthorized', and the error never carries the response body", async () => {
  const { f } = fakeNetlify({ status: { "GET /user": 401 } });
  await assert.rejects(() => verifyToken("bad", f), (e: any) => e instanceof ProviderError && e.kind === "unauthorized" && !/secret/.test(e.message));
});

test("first publish creates a site, uploads every file, and returns the live address", async () => {
  const { f, calls } = fakeNetlify();
  const out = await publish("tok", FILES, null, { fetch: f, sleep: noSleep });
  assert.equal(out.siteId, "new-site");
  assert.equal(out.url, "https://new-site.netlify.app");
  const deployBody = JSON.parse(calls.find((c) => c.method === "POST" && c.path.endsWith("/deploys"))!.body!);
  assert.deepEqual(deployBody.files, { "/index.html": sha1(FILES[0].contents), "/css/site.css": sha1(FILES[1].contents), "/about us.html": sha1(FILES[2].contents) });
  const uploads = calls.filter((c) => c.method === "PUT");
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every((u) => u.contentType === "application/octet-stream"));
  assert.ok(uploads.some((u) => u.path === "/deploys/dep-1/files/about%20us.html"), "file names are escaped");
  assert.ok(calls.every((c) => c.auth === "Bearer tok"), "every call is authenticated");
});

test("only files Netlify does not already have are uploaded", async () => {
  const { f, calls } = fakeNetlify({ have: [sha1(FILES[0].contents), sha1(FILES[1].contents)] });
  await publish("tok", FILES, null, { fetch: f, sleep: noSleep });
  const uploads = calls.filter((c) => c.method === "PUT");
  assert.deepEqual(uploads.map((u) => u.path), ["/deploys/dep-1/files/about%20us.html"]);
  assert.equal(uploads[0].body, "<p>About</p>");
});

test("republishing reuses the same site, so the address stays the same", async () => {
  const { f, calls } = fakeNetlify({ existing: ["kept-site"] });
  const out = await publish("tok", FILES, "kept-site", { fetch: f, sleep: noSleep });
  assert.equal(out.siteId, "kept-site");
  assert.ok(!calls.some((c) => c.method === "POST" && c.path === "/sites"), "no new site was created");
});

test("if the old site was deleted on Netlify, a new one is created instead of failing", async () => {
  const { f } = fakeNetlify({ existing: [] });
  assert.equal((await publish("tok", FILES, "deleted-site", { fetch: f, sleep: noSleep })).siteId, "new-site");
});

test("it waits for Netlify to finish processing before calling it published", async () => {
  const { f, calls } = fakeNetlify({ states: ["uploading", "processing", "ready"] });
  await publish("tok", FILES, null, { fetch: f, sleep: noSleep });
  assert.equal(calls.filter((c) => c.method === "GET" && c.path === "/sites/new-site/deploys/dep-1").length, 3);
});

test("a deploy that errors on Netlify's side is reported as a failure, not a success", async () => {
  const { f } = fakeNetlify({ states: ["processing", "error"] });
  await assert.rejects(() => publish("tok", FILES, null, { fetch: f, sleep: noSleep }), (e: any) => e.kind === "rejected");
});

test("a deploy that never finishes is reported, not waited on forever", async () => {
  const { f } = fakeNetlify({ states: ["processing"] });
  await assert.rejects(() => publish("tok", FILES, null, { fetch: f, sleep: noSleep, maxPolls: 3 }), (e: any) => e.kind === "unavailable");
});

test("Netlify's rate limit is 'try again', and a revoked token is 'reconnect'", async () => {
  await assert.rejects(() => publish("tok", FILES, null, { fetch: fakeNetlify({ status: { "POST /sites": 429 } }).f, sleep: noSleep }), (e: any) => e.kind === "unavailable");
  await assert.rejects(() => publish("tok", FILES, null, { fetch: fakeNetlify({ status: { "POST /sites": 401 } }).f, sleep: noSleep }), (e: any) => e.kind === "unauthorized");
});

test("file names Netlify cannot take are refused", () => {
  assert.throws(() => encodeFilePath("a#b.html"), ProviderError);
  assert.throws(() => encodeFilePath("a?b.html"), ProviderError);
  assert.equal(encodeFilePath("dir/naïve file.html"), "dir/na%C3%AFve%20file.html");
});
