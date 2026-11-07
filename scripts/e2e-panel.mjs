/**
 * End-to-end check of the "Suggested events" panel in a real browser, against a fake API.
 *
 * Covers what unit tests cannot: that panel.ts renders suggestions safely, collects the times
 * the assistant refused to guess, sends the right request through the real service worker, and
 * reacts to each kind of server answer. The server's own logic (claiming, provider calls, SQL)
 * is covered by test/flows.test.ts; this fake only needs to behave like it.
 *
 *   API_BASE=http://127.0.0.1:4470 npm run build:chrome && node scripts/e2e-panel.mjs
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

const T = (h) => new Date(Date.UTC(2026, 10, 10, h, 0, 0)).toISOString();
let proposals = [
  { id: "p-dentist", title: "Dentist", start: T(15), end: T(16), all_day: false, location: "12 Main St", needs_review: [], assumptions: [], source: "vision" },
  { id: "p-flyer", title: "Flyer concert", start: T(19), end: null, all_day: false, location: null, needs_review: ["end_time"], assumptions: ["No end time given; left null rather than assuming a duration."], source: "vision" },
  { id: "p-lunch", title: "Team lunch", start: T(12), end: T(13), all_day: false, location: null, needs_review: [], assumptions: [], source: "vision" },
  { id: "p-old", title: "Old calendar", start: T(9), end: T(10), all_day: false, location: null, needs_review: [], assumptions: [], source: "vision" },
  { id: "p-blank", title: "Whiteboard thing", start: null, end: null, all_day: false, location: null, needs_review: ["start_time", "_image_legibility"], assumptions: [], source: "vision" },
  { id: "p-dismiss", title: "Dismiss me", start: T(8), end: T(9), all_day: false, location: null, needs_review: [], assumptions: [], source: "vision" },
  { id: "p-evil", title: "<img src=x onerror=\"window.__pwned=1\">Evil", start: T(7), end: T(8), all_day: false, location: "\"><script>window.__pwned=2</script>", needs_review: [], assumptions: ["<b>bold</b>"], source: "vision" },
];
const requests = [];
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
const send = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const b = req.method === "POST" ? await body(req) : {};
  requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body: b });
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (url.pathname === "/proposals" && req.method === "GET") return send(res, 200, { proposals });
  if (url.pathname === "/events/active") return send(res, 200, []);
  if (url.pathname === "/sync") return send(res, 200, { ok: true, synced: 0, reconnect: [], failed: [] });

  const m = url.pathname.match(/^\/proposals\/([^/]+)\/(confirm|reject)$/);
  if (m) {
    const [, id, action] = m;
    const p = proposals.find((x) => x.id === id);
    if (!p) return send(res, 404, { error: "I can't find that suggestion.", code: null });
    const done = () => { proposals = proposals.filter((x) => x.id !== id); };
    if (action === "reject") { done(); return send(res, 200, { ok: true }); }
    if (id === "p-flyer" && !b.end) return send(res, 400, { error: "This needs an end time before it can be added.", code: "needs_end_time" });
    if (id === "p-blank" && (!b.start || !b.end)) return send(res, 400, { error: "This needs a start time before it can be added.", code: "needs_start_time" });
    if (id === "p-lunch" && !b.provider) return send(res, 409, { error: "Choose which calendar to add this to.", code: "choose_calendar" });
    if (id === "p-old") return send(res, 409, { error: "Your calendar sign-in has expired. Reconnect it in Settings, then try again.", code: "reconnect_needed" });
    done();
    return send(res, 200, { ok: true, provider: b.provider ?? "google", eventId: "e1" });
  }
  send(res, 404, { error: "no route", code: null });
}).listen(PORT, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

/* ---------------- drive the real extension ---------------- */

const profile = await mkdtemp(path.join(tmpdir(), "pcc-panel-"));
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
const lastReq = (p) => [...requests].reverse().find((r) => r.path === p);

let page;
try {
  page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/sidepanel.html`);
  await page.waitForSelector("#suggestSection:not([hidden])", { timeout: 8000 });
  const card = (id) => page.locator(`.suggest-card[data-id="${id}"]`);
  const note = (id) => card(id).locator("[data-note]");

  await check("all suggestions render", async () => (await page.locator(".suggest-card").count()) === 7);
  await check("the signed-in token is sent on every call", async () =>
    requests.filter((r) => r.path === "/proposals").every((r) => r.auth === "Bearer test-token-abc"));

  await check("HTML in a title, location or assumption is shown as text and never runs", async () => {
    const evil = card("p-evil");
    const injected = await evil.locator("img, script, b").count();
    const pwned = await page.evaluate(() => window.__pwned);
    const text = await evil.textContent();
    return injected === 0 && pwned === undefined && text.includes("<img src=x") && text.includes("<b>bold</b>")
      ? true : `injected=${injected} pwned=${pwned}`;
  });

  await check("a suggestion with a missing end asks for one, and that field starts blank", async () =>
    (await card("p-flyer").locator("input[data-end]").inputValue()) === "" && (await card("p-flyer").locator("input[data-start]").count()) === 0);
  await check("a suggestion with nothing found asks for both times", async () =>
    (await card("p-blank").locator("input[data-start]").count()) === 1 && (await card("p-blank").locator("input[data-end]").count()) === 1);
  await check("the review hints are plain language, not field names", async () => {
    const t = await card("p-blank").textContent();
    return t.includes("the start time") && t.includes("the photo was hard to read") && !t.includes("_image_legibility");
  });

  // ---- adding a complete suggestion ----
  const before = requests.filter((r) => r.path === "/proposals/p-dentist/confirm").length;
  await card("p-dentist").locator("[data-add]").click();
  await card("p-dentist").waitFor({ state: "detached", timeout: 5000 });
  await check("Add sends one confirm with no invented fields, then the card goes away", async () => {
    const reqs = requests.filter((r) => r.path === "/proposals/p-dentist/confirm");
    return reqs.length === before + 1 && reqs[0].body.start === undefined && reqs[0].body.end === undefined && reqs[0].body.provider === undefined
      ? true : JSON.stringify(reqs.map((r) => r.body));
  });
  await check("the user is told it was added and to check it", async () => /Added to your calendar/.test(await page.locator("#toast").textContent()));

  // ---- the missing end time is the user's call ----
  await card("p-flyer").locator("[data-add]").click();
  await check("Add without the missing end time sends NOTHING and says what is needed", async () => {
    const n = requests.filter((r) => r.path === "/proposals/p-flyer/confirm").length;
    return n === 0 && /end time/i.test(await note("p-flyer").textContent()) ? true : `requests=${n}`;
  });
  await card("p-flyer").locator("input[data-end]").fill("2026-11-10T21:30");
  await card("p-flyer").locator("[data-add]").click();
  await card("p-flyer").waitFor({ state: "detached", timeout: 5000 });
  await check("the typed end time is sent as an absolute instant for the user's own wall-clock time", async () => {
    const sent = requests.find((r) => r.path === "/proposals/p-flyer/confirm").body.end;
    return sent === new Date("2026-11-10T21:30").toISOString() ? true : `sent ${sent}`;
  });

  // ---- both times missing ----
  await card("p-blank").locator("[data-add]").click();
  await check("with both times missing the start is asked for first", async () =>
    /start time/i.test(await note("p-blank").textContent()) && requests.every((r) => r.path !== "/proposals/p-blank/confirm"));
  await card("p-blank").locator("input[data-start]").fill("2026-11-10T08:00");
  await card("p-blank").locator("[data-add]").click();
  await check("then the end", async () => /end time/i.test(await note("p-blank").textContent()));
  await card("p-blank").locator("input[data-end]").fill("2026-11-10T09:00");
  await card("p-blank").locator("[data-add]").click();
  await card("p-blank").waitFor({ state: "detached", timeout: 5000 });
  await check("both are sent once supplied", async () => {
    const b = requests.find((r) => r.path === "/proposals/p-blank/confirm").body;
    return b.start === new Date("2026-11-10T08:00").toISOString() && b.end === new Date("2026-11-10T09:00").toISOString() ? true : JSON.stringify(b);
  });

  // ---- two calendars connected ----
  await check("the calendar-choice buttons are NOT visible until the server asks for a choice", async () => {
    const visible = await card("p-lunch").locator("[data-provider]").first().isVisible();
    return visible === false ? true : "the Google/Outlook buttons are showing on a card that has not asked yet";
  });
  await card("p-lunch").locator("[data-add]").click();
  await card("p-lunch").locator("[data-choice]:not([hidden])").waitFor({ timeout: 5000 });
  await check("with two calendars, the card asks which one, shows the buttons, and keeps the suggestion", async () =>
    /Choose which calendar/.test(await note("p-lunch").textContent()) && (await card("p-lunch").count()) === 1
    && (await card("p-lunch").locator('[data-provider="microsoft"]').isVisible()));
  await card("p-lunch").locator('[data-provider="microsoft"]').click();
  await card("p-lunch").waitFor({ state: "detached", timeout: 5000 });
  await check("choosing Outlook sends that provider", async () =>
    requests.filter((r) => r.path === "/proposals/p-lunch/confirm").pop().body.provider === "microsoft");

  // ---- an expired sign-in ----
  await card("p-old").locator("[data-add]").click();
  await check("an expired sign-in shows the server's message and leaves the suggestion in place", async () => {
    await page.waitForFunction(() => /Reconnect/.test(document.querySelector('.suggest-card[data-id="p-old"] [data-note]')?.textContent ?? ""));
    const stillThere = (await card("p-old").count()) === 1;
    const enabled = await card("p-old").locator("[data-add]").isEnabled();
    return stillThere && enabled ? true : `stillThere=${stillThere} enabled=${enabled}`;
  });

  // ---- dismiss ----
  await card("p-dismiss").locator("[data-reject]").click();
  await card("p-dismiss").waitFor({ state: "detached", timeout: 5000 });
  await check("Dismiss tells the server and removes the card", async () => lastReq("/proposals/p-dismiss/reject") !== undefined);
  await card("p-evil").locator("[data-reject]").click();
  await card("p-evil").waitFor({ state: "detached", timeout: 5000 });
  await card("p-old").locator("[data-reject]").click();
  await card("p-old").waitFor({ state: "detached", timeout: 5000 });
  await check("when the last suggestion is gone the section hides itself", async () =>
    await page.locator("#suggestSection").isHidden());
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
