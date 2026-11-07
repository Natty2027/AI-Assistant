/**
 * End-to-end check of screen-share / mic detection in a real browser.
 *
 * Unit tests cover the tracking logic; this proves the part they cannot: that a real page
 * calling getUserMedia / getDisplayMedia is actually observed by the page-world script, relayed
 * by the content script, and recorded per tab in the service worker.
 *
 *   npm run build && node scripts/e2e-signals.mjs
 *
 * Uses Playwright's Chromium (Google Chrome's official build ignores --load-extension) and
 * Chromium's fake media devices, so no camera, microphone or screen is touched.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
// EXT_PATH lets a test point at a modified copy of the build (e.g. to prove this test can fail).
const extensionPath = process.env.EXT_PATH ?? path.join(root, "dist/chrome");

const server = createServer((_q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end("<!doctype html><title>signals test page</title><body>test</body>");
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = await mkdtemp(path.join(tmpdir(), "pcc-e2e-"));
const context = await chromium.launchPersistentContext(profile, {
  // Extensions do not load in Playwright's default headless shell; "chromium" selects the
  // full browser in its new headless mode.
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });

const results = [];
const record = (name, ok, detail = "") => results.push({ name, ok, detail });

const tabSignals = () =>
  sw.evaluate(async () => (await chrome.storage.session.get("tabSignals")).tabSignals ?? {});
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await settle(100);
  }
  return false;
}
const anyTab = (s, key) => Object.values(s).some((v) => v[key]);

try {
  const tab1 = await context.newPage();
  await tab1.goto(url);

  record("starts with no signals", Object.keys(await tabSignals()).length === 0);

  // ---- microphone ----
  await tab1.evaluate(async () => {
    window.__mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  });
  record("mic: getUserMedia is detected from the page", await until(async () => anyTab(await tabSignals(), "micActive")),
    JSON.stringify(await tabSignals()));

  // stop() fires no 'ended' event; this is how every call app's own mute/stop button works.
  await tab1.evaluate(() => window.__mic.getTracks().forEach((t) => t.stop()));
  record("mic: track.stop() clears it (no 'ended' event involved)", await until(async () => !anyTab(await tabSignals(), "micActive")),
    JSON.stringify(await tabSignals()));

  // ---- screen share ----
  let displayErr = null;
  try {
    await tab1.evaluate(async () => {
      window.__screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
    });
  } catch (e) { displayErr = String(e.message).split("\n")[0]; }

  if (displayErr) {
    record("screen: getDisplayMedia is detected from the page", false,
      `could not start capture in this headless browser: ${displayErr}`);
  } else {
    record("screen: getDisplayMedia is detected from the page", await until(async () => anyTab(await tabSignals(), "screenSharing")),
      JSON.stringify(await tabSignals()));
    await tab1.evaluate(() => window.__screen.getTracks().forEach((t) => t.stop()));
    record("screen: track.stop() clears it", await until(async () => !anyTab(await tabSignals(), "screenSharing")),
      JSON.stringify(await tabSignals()));
  }

  // ---- per-tab isolation: tab 2 going quiet must not erase tab 1 ----
  await tab1.evaluate(async () => { window.__mic2 = await navigator.mediaDevices.getUserMedia({ audio: true }); });
  await until(async () => anyTab(await tabSignals(), "micActive"));
  const tab2 = await context.newPage();
  await tab2.goto(url);
  await tab2.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  });
  await settle(800);
  record("two tabs: tab 2 stopping does not clear tab 1's mic", anyTab(await tabSignals(), "micActive"),
    JSON.stringify(await tabSignals()));

  // ---- closing the tab clears its state even though no stop() ever ran ----
  await tab1.close();
  record("closing the tab clears its signals", await until(async () => !anyTab(await tabSignals(), "micActive")),
    JSON.stringify(await tabSignals()));

  // ---- the page world is not polluted ----
  const leaks = await tab2.evaluate(() => ({
    tracker: typeof tracker, MARK: typeof MARK, SignalTracker: typeof SignalTracker,
  }));
  record("no names leak into the page's global scope",
    Object.values(leaks).every((v) => v === "undefined"), JSON.stringify(leaks));
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `   <- ${r.detail}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
