/**
 * End-to-end check of the Create page in a real browser, against a fake API.
 *
 * Covers what unit tests cannot: that create.ts shows the person exactly what will be published,
 * sends back the hash of what it showed, requires the confirmations the server asks for, never
 * runs the site's own scripts in the preview, and that the service-worker bridge refuses any
 * route that is not an assistant route. The server logic is covered by test/agentService.test.ts.
 *
 *   API_BASE=http://127.0.0.1:4470 npm run build:chrome && node scripts/e2e-create.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4470;
const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const extensionPath = process.env.EXT_PATH ?? path.join(root, "dist/chrome");

if (!readFileSync(path.join(extensionPath, "sw.js"), "utf8").includes(`127.0.0.1:${PORT}`)) {
  console.error(`dist/chrome was not built for this test. Run:\n  API_BASE=http://127.0.0.1:${PORT} npm run build:chrome`);
  process.exit(2);
}

/* ---------------- a fake API that answers like the real one ---------------- */

const HASH = "a".repeat(64);
let connections = [{ id: "c-1", label: "Netlify (owner@example.com)" }];
let site = { files: [], checks: [], contentHash: "e".repeat(64) };
const FILES = {
  "index.html": `<html><head><link rel="stylesheet" href="site.css"></head><body><h1 id="hello">Clay Corner</h1>
    <script>parent.__pwned = 1; window.top.__pwned = 1;</script></body></html>`,
  "site.css": "h1 { color: rgb(1, 2, 3); }",
};
let proposals = [
  { id: "p-old", kind: "site.deploy", label: "Publish website", summary: "An older version", payload: { connectionId: "c-1", siteId: "u-1", contentHash: "b".repeat(64) },
    payloadHash: "h-old", checks: [], tainted: false, status: "pending", expiresAt: new Date(Date.now() + 9e5).toISOString(), result: null, canBeCarriedOut: true },
  { id: "p-post", kind: "social.post", label: "Social post", summary: "<img src=x onerror=\"window.__pwned=2\">Saturday class",
    payload: { connectionId: "x1", text: "Come make a mug! <b>Saturdays</b>", link: null, sponsored: false, mediaRefs: [] },
    payloadHash: "h-post", checks: [], tainted: false, status: "pending", expiresAt: new Date(Date.now() + 9e5).toISOString(), result: null, canBeCarriedOut: false },
];
const requests = [];
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
const send = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const b = req.method === "POST" ? await body(req) : {};
  requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body: b });
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const p = url.pathname;

  if (p === "/agent/connections" && req.method === "GET") return send(res, 200, { connections });
  if (p === "/agent/connections/netlify") {
    if (b.token !== "nfp_good_token_1234567890") return send(res, 400, { error: "Netlify didn't accept that token.", code: "bad_token" });
    connections = [...connections, { id: "c-2", label: "Netlify (second@example.com)" }];
    return send(res, 200, { ok: true, connection: connections.at(-1) });
  }
  let m = p.match(/^\/agent\/connections\/([^/]+)$/);
  if (m && req.method === "DELETE") { connections = connections.filter((c) => c.id !== m[1]); return send(res, 200, { ok: true }); }

  if (p === "/agent/run") {
    site = { files: [{ path: "index.html", bytes: 120 }, { path: "site.css", bytes: 28 }], checks: [{ id: "contact", level: "warn", message: "There's no way to contact you on the site." }], contentHash: HASH };
    proposals = [{ id: "p-new", kind: "site.deploy", label: "Publish website", summary: "Publish the Clay Corner website",
      payload: { connectionId: "c-1", siteId: "u-1", contentHash: HASH }, payloadHash: "h-new",
      checks: [{ id: "claims", level: "attest", message: "Every claim on the site is true and you can back it up." }],
      tainted: true, status: "pending", expiresAt: new Date(Date.now() + 9e5).toISOString(), result: null, canBeCarriedOut: true }, ...proposals];
    return send(res, 200, { status: "done", text: "Your site is ready for you to review.", proposals: [], drafts: [], tainted: true });
  }
  if (p === "/agent/proposals") return send(res, 200, { proposals });
  if (p === "/agent/site") return send(res, 200, site);
  if (p === "/agent/site/file") return send(res, 200, { contents: FILES[url.searchParams.get("path")] ?? "" });

  m = p.match(/^\/agent\/proposals\/([^/]+)\/(approve|execute|reject)$/);
  if (m) {
    const [, id, action] = m;
    const prop = proposals.find((x) => x.id === id);
    if (!prop) return send(res, 404, { error: "Not found", code: "not_found" });
    if (action === "reject") { prop.status = "rejected"; return send(res, 200, { ok: true }); }
    if (action === "approve") {
      if (b.payload_hash !== prop.payloadHash) return send(res, 409, { error: "What you approved is not what was proposed.", code: "hash_mismatch" });
      if (!(b.attestations ?? []).includes("claims")) return send(res, 409, { error: "Please confirm: claims.", code: "attestation_required" });
      if (prop.tainted && b.acknowledge_taint !== true) return send(res, 409, { error: "Confirm you have read exactly what it will do.", code: "taint_ack_required" });
      return send(res, 200, { token: "approval-xyz", expires_at: new Date().toISOString() });
    }
    if (b.token !== "approval-xyz") return send(res, 409, { error: "bad token", code: "bad_approval" });
    prop.status = "executed";
    prop.result = { ref: "https://clay-corner.netlify.app" };
    return send(res, 200, { ok: true, proposal: prop });
  }
  send(res, 404, { error: "no route", code: null });
}).listen(PORT, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

/* ---------------- drive the real extension ---------------- */

const profile = await mkdtemp(path.join(tmpdir(), "pcc-create-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
const extId = new URL(sw.url()).host;
await sw.evaluate(() => chrome.storage.local.set({ authToken: "test-token-abc" }));

const results = [];
const record = (name, ok, detail = "") => results.push({ name, ok, detail });
const check = async (name, fn) => { try { const r = await fn(); record(name, r === true || r === undefined, String(r)); } catch (e) { record(name, false, String(e.message).split("\n")[0]); } };
const card = (id) => page.locator(`[data-proposal="${id}"]`);
const reqs = (p, method = "POST") => requests.filter((r) => r.path === p && r.method === method);

let page;
try {
  page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/create.html`);
  await page.waitForSelector(`[data-proposal="p-post"]`, { timeout: 8000 });

  /* ---- the bridge ---- */
  await check("the page cannot use the bridge to reach non-assistant routes", async () => {
    const before = requests.length;
    const outs = await page.evaluate(async () => Promise.all([
      chrome.runtime.sendMessage({ type: "agent:call", method: "POST", path: "/account/delete", body: { confirm: "DELETE" } }),
      chrome.runtime.sendMessage({ type: "agent:call", method: "GET", path: "/agent/../oauth/tokens" }),
      chrome.runtime.sendMessage({ type: "agent:call", method: "DELETE", path: "/agent/proposals" }),
      chrome.runtime.sendMessage({ type: "agent:call", method: "GET", path: "https://evil.example/agent/site" }),
    ]));
    return outs.every((o) => o.ok === false && o.error === "not allowed") && requests.length === before ? true : JSON.stringify(outs);
  });
  await check("calls carry the sign-in token, which the page itself never holds", async () =>
    requests.every((r) => r.auth === "Bearer test-token-abc") && (await page.evaluate(() => localStorage.length)) === 0);

  /* ---- connections ---- */
  await check("the connected account is listed", async () => /owner@example\.com/.test(await page.locator("#connList").textContent()));
  await page.fill("#tokenInput", "nope");
  await page.click("#connForm button");
  await page.waitForFunction(() => /accept/.test(document.querySelector("#connMsg").textContent));
  await check("a rejected token shows the server's reason", async () => /didn't accept/.test(await page.locator("#connMsg").textContent()));
  await page.fill("#tokenInput", "nfp_good_token_1234567890");
  await page.click("#connForm button");
  await page.waitForFunction(() => /second@/.test(document.querySelector("#connList").textContent));
  await check("a good token connects, and the field is cleared so the token is not left on screen", async () =>
    (await page.inputValue("#tokenInput")) === "" && !(await page.content()).includes("nfp_good_token"));
  await page.click(`[data-disconnect="c-2"]`);
  await page.waitForFunction(() => !/second@/.test(document.querySelector("#connList").textContent));
  await check("Remove deletes the connection on the server", async () => reqs("/agent/connections/c-2", "DELETE").length === 1);

  /* ---- what can't be carried out ---- */
  await check("a social post shows its exact text but offers no approve button", async () =>
    (await card("p-post").locator("[data-approve]").count()) === 0 && /post it yourself/.test(await card("p-post").textContent()));
  await check("HTML in a summary or post is shown as text and never runs", async () => {
    const injected = await card("p-post").locator("img, b").count();
    const t = await card("p-post").textContent();
    return injected === 0 && t.includes("<b>Saturdays</b>") && (await page.evaluate(() => window.__pwned)) === undefined ? true : `injected=${injected}`;
  });

  /* ---- build ---- */
  await page.fill("#requestInput", "A one-page site for my pottery classes");
  await page.click("#runBtn");
  await page.waitForSelector(`[data-proposal="p-new"]`, { timeout: 8000 });
  await check("Start sends the request, and web search stays off unless ticked", async () => {
    const r = reqs("/agent/run")[0];
    return r?.body.request === "A one-page site for my pottery classes" && r.body.allow_web_search === false ? true : JSON.stringify(r?.body);
  });
  await page.waitForFunction(() => document.querySelector("#preview").srcdoc.includes("Clay Corner"));
  await check("the preview shows the site with its stylesheet, in a frame with every permission off", async () => {
    const frame = page.frameLocator("#preview");
    const color = await frame.locator("#hello").evaluate((n) => getComputedStyle(n).color);
    return (await page.getAttribute("#preview", "sandbox")) === "" && color === "rgb(1, 2, 3)" ? true : `color=${color}`;
  });
  await check("the site's own scripts do not run in the preview", async () => (await page.evaluate(() => window.__pwned)) === undefined);
  await check("site warnings are shown", async () => /no way to contact/.test(await page.locator("#siteChecks").textContent()));
  await check("an older proposal for a different version is flagged as out of date", async () =>
    /changed after this was proposed/.test(await card("p-old").textContent()));

  /* ---- approve ---- */
  await card("p-new").locator("[data-approve]").click();
  await card("p-new").locator("[data-msg]").filter({ hasText: /confirm/i }).waitFor({ timeout: 5000 });
  await check("approving without ticking the confirmation is refused and nothing is published", async () =>
    reqs("/agent/proposals/p-new/execute").length === 0 && /Please confirm/.test(await card("p-new").locator("[data-msg]").textContent()));
  await card("p-new").locator(`[data-attest="claims"]`).check();
  await card("p-new").locator("[data-approve]").click();
  await card("p-new").locator("[data-msg]").filter({ hasText: /exactly what it will do/ }).waitFor({ timeout: 5000 });
  await check("something shaped by web content also needs its own acknowledgement", async () => reqs("/agent/proposals/p-new/execute").length === 0);
  await card("p-new").locator("[data-taint]").check();
  await card("p-new").locator("[data-approve]").click();
  await card("p-new").locator("a[href='https://clay-corner.netlify.app']").waitFor({ timeout: 5000 });
  await check("with both ticked it approves the hash it showed, then publishes with that one approval", async () => {
    const a = reqs("/agent/proposals/p-new/approve").at(-1).body;
    const e = reqs("/agent/proposals/p-new/execute");
    return a.payload_hash === "h-new" && a.attestations.join() === "claims" && a.acknowledge_taint === true && e.length === 1 && e[0].body.token === "approval-xyz"
      ? true : JSON.stringify({ a, e: e.map((x) => x.body) });
  });
  await check("the live address is shown and opens safely in a new tab", async () =>
    (await card("p-new").locator("a").getAttribute("rel")) === "noopener noreferrer");

  /* ---- reject ---- */
  await card("p-old").locator("[data-reject]").click();
  await page.waitForFunction(() => /rejected/.test(document.querySelector('[data-proposal="p-old"]').textContent));
  await check("Reject tells the server", async () => reqs("/agent/proposals/p-old/reject").length === 1);
} catch (e) {
  record("script ran to completion", false, String(e.message).split("\n")[0]);
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `   <- ${r.detail}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
