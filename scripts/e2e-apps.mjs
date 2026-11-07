/**
 * End-to-end check of app control: real browser, real panel, real native helper, a real app.
 *
 *   npm run build && node scripts/e2e-apps.mjs
 *
 * What it does on this Mac: it launches Calculator (only if Calculator is not already running,
 * so it never disturbs your own work) and stops it again when finished. It deliberately does NOT
 * perform a real "close": the first close of any app makes macOS show an "allow this browser to
 * control that app" prompt, and a test should not throw a permission dialog at whoever is at the
 * keyboard. Closing is tested up to and including the confirmation step, and everything the
 * helper does on a close is covered by native-host/test_app_control.py.
 *
 * It installs the helper into the test browser's own profile (via the real installer script),
 * never into your real browsers.
 */
import { chromium } from "playwright";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") { console.log("macOS only. Skipping."); process.exit(0); }

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const extensionPath = process.env.EXT_PATH ?? path.join(root, "dist/chrome");
const CALC = "com.apple.calculator";
const CHROME = "com.google.Chrome";

const running = (name) => spawnSync("pgrep", ["-x", name]).status === 0;
const calcWasRunning = running("Calculator");

const profile = await mkdtemp(path.join(tmpdir(), "pcc-apps-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
const extId = new URL(sw.url()).host;

const results = [];
const record = (name, ok, detail = "") => results.push({ name, ok, detail });
// A check passes only if it returns exactly `true`. Returning undefined (say, from `a?.b` on a
// failed lookup) must NOT count as a pass, or a broken helper would show up green.
const check = async (name, fn) => { try { const r = await fn(); record(name, r === true, String(r)); } catch (e) { record(name, false, String(e.message).split("\n")[0]); } };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await settle(150); } return false; }

let launchedCalc = false;
try {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/sidepanel.html`);
  const ask = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const setPrefs = (prefs) => sw.evaluate((p) => chrome.storage.local.set({ appControl: p }), prefs);

  /* ---- before the helper exists ---- */
  await check("with app control off, the list is refused", async () => (await ask({ type: "apps:list" })).error === "disabled");
  await setPrefs({ enabled: true, allowed: [CALC] });
  await check("with it on but no helper installed, it says so instead of failing silently", async () => {
    const r = await ask({ type: "apps:list" });
    return r.ok === false && r.error === "host_missing" ? true : JSON.stringify(r);
  });

  /* ---- install the helper the way a user would, but into the test profile only ---- */
  const nmh = path.join(profile, "NativeMessagingHosts");
  await mkdir(nmh, { recursive: true });
  // HELPER_DIR keeps the copied helper inside the test profile too, so nothing lands in the real
  // ~/Library. (The real installer copies it out of the project folder for a reason: macOS blocks a
  // browser-launched program from reading ~/Documents.)
  execFileSync(path.join(root, "native-host/install-app-control.sh"), [extId], {
    env: { ...process.env, NMH_DIR: nmh, HELPER_DIR: path.join(profile, "helper") }, stdio: "pipe",
  });

  /* ---- the real helper answers ---- */
  const list = await ask({ type: "apps:list" });
  await check("the real helper lists this Mac's installed apps", async () =>
    list.ok && Array.isArray(list.apps) && list.apps.length > 5 ? true : JSON.stringify(list).slice(0, 200));
  await check("Calculator is in the list", async () => list.ok === true && list.apps.some((a) => a.id === CALC));
  await check("the browser is flagged protected so it can never be closed", async () =>
    list.ok === true && list.apps.find((a) => a.id === CHROME)?.protected === true);
  await check("no background agents or helper apps are offered", async () =>
    list.ok === true && !list.apps.some((a) => /helper|agent/i.test(a.name) && a.id.includes("helper")));

  /* ---- gating: every refusal happens before anything reaches the helper ---- */
  await check("an app the user did not allow is refused", async () =>
    (await ask({ type: "apps:run", verb: "open", id: "com.apple.TextEdit" })).error === "not_allowed");
  await check("closing without the confirmation step is refused", async () =>
    (await ask({ type: "apps:run", verb: "close", id: CALC })).error === "confirmation_required");
  await check("a nonsense verb is refused", async () =>
    (await ask({ type: "apps:run", verb: "destroy", id: CALC })).error === "bad_request");
  await check("an injection-shaped id is refused as not allowed", async () =>
    (await ask({ type: "apps:run", verb: "open", id: 'x" to quit\ndo shell script "id' })).error === "not_allowed");

  /* ---- the panel ---- */
  await page.reload();
  await page.waitForSelector("#appsSection:not([hidden])", { timeout: 10_000 });
  const row = (id) => page.locator(`.app-row[data-id="${id}"]`);

  await check("the panel shows only the apps the user allowed", async () =>
    (await page.locator(".app-row").count()) === 1 && (await row(CALC).count()) === 1);

  if (calcWasRunning) {
    record("(skipped real launch: Calculator was already open, so it was left alone)", true);
  } else {
    await page.fill("#appsInput", "please open the calculator app");
    await page.click('#appsForm button[type="submit"]');
    await check("typing a command really launches the app", async () =>
      (await until(() => running("Calculator"))) ? ((launchedCalc = true), true) : "Calculator never started");
    await check("the panel confirms it in words", async () => /Opened Calculator/.test(await page.locator("#appsNote").textContent()));

    await page.reload();
    await page.waitForSelector(`.app-row[data-id="${CALC}"]`);
    await check("after a reload the row shows it running, and offers Show instead of Open", async () => {
      const dot = await row(CALC).locator(".app-dot").getAttribute("data-running");
      const label = await row(CALC).locator('[data-act="open"]').textContent();
      return dot === "true" && label === "Show" ? true : `dot=${dot} label=${label}`;
    });

    // ---- closing always asks first, and cancelling changes nothing ----
    await row(CALC).locator('[data-act="close"]').click();
    await check("pressing Close shows a confirmation and does NOT close the app yet", async () => {
      const text = await row(CALC).locator(".app-confirm").textContent();
      return /Unsaved work/i.test(text) && running("Calculator") ? true : `confirm="${text}" running=${running("Calculator")}`;
    });
    await row(CALC).locator(".app-confirm >> text=Cancel").click();
    await check("Cancel dismisses it and the app is untouched", async () =>
      (await row(CALC).locator(".app-confirm").count()) === 0 && running("Calculator"));

    await page.fill("#appsInput", "quit calculator");
    await page.click('#appsForm button[type="submit"]');
    await check("typing a close command also asks first", async () =>
      (await row(CALC).locator(".app-confirm").count()) === 1 && running("Calculator"));
    await row(CALC).locator(".app-confirm >> text=Cancel").click();
  }

  /* ---- commands that must not do anything ---- */
  const tryCmd = async (text) => { await page.fill("#appsInput", text); await page.click('#appsForm button[type="submit"]'); return (await page.locator("#appsNote").textContent()).trim(); };
  await check("an app that is not allowed gets a clear explanation", async () => /allowed in Settings/.test(await tryCmd("open photoshop")));
  await check("force-style words are not understood", async () => /Try "open/.test(await tryCmd("kill calculator")));
  await check("plain text is not treated as a command", async () => /Try "open/.test(await tryCmd("what time is it")));
  await check("a compound request does not guess", async () => /allowed in Settings/.test(await tryCmd("open calculator and safari")));

  /* ---- the browser can never be closed from here ---- */
  await setPrefs({ enabled: true, allowed: [CALC, CHROME] });
  await page.reload();
  await page.waitForSelector(`.app-row[data-id="${CHROME}"]`);
  await check("a protected app's Close button is disabled", async () => await row(CHROME).locator('[data-act="close"]').isDisabled());
  await check("typing 'close chrome' explains why it won't, with no confirmation offered", async () => {
    const note = await tryCmd("close chrome");
    return /protected/i.test(note) && (await row(CHROME).locator(".app-confirm").count()) === 0 ? true : note;
  });

  /* ---- turning it off takes effect immediately ---- */
  await setPrefs({ enabled: false, allowed: [CALC] });
  await check("switching it off blocks the next request", async () =>
    (await ask({ type: "apps:run", verb: "open", id: CALC })).error === "disabled");
  await page.reload();
  await check("and the Quick actions section disappears", async () => await page.locator("#appsSection").isHidden());

  /* ---- web pages cannot reach any of this ---- */
  const evil = await context.newPage();
  await evil.goto("about:blank");
  await check("a normal web page cannot talk to the helper through the extension", async () => {
    const r = await evil.evaluate(() => (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) ? "no-api" : "has-api");
    return r === "no-api" ? true : r;
  });
} catch (e) {
  record("script ran to completion", false, String(e.message).split("\n")[0]);
} finally {
  await context.close();
  // Stop only what this test started. If Calculator was already open, it is left exactly as found.
  if (launchedCalc && !calcWasRunning) spawnSync("pkill", ["-x", "Calculator"]);
  await rm(profile, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `   <- ${r.detail}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
