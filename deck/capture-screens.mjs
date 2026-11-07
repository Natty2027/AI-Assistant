/**
 * Takes the product screenshots used in the deck, from the real built extension.
 *
 *   npm run deck:screens
 *
 * Three shots, each a real render of the real panel (not a mock-up):
 *   panel-overview     the panel's own built-in demo data: quiet state, timeline, held alerts
 *   panel-suggestions  the Suggested events list, fed by a fake API
 *   panel-apps         Quick actions, using the real app helper (nothing is launched or closed)
 *
 * The suggestions come from a small fake API, so the text on screen is sample content, and the
 * deck labels it that way. The apps shot lists real apps installed on this Mac.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4471;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outDir = path.join(here, "assets");
const extensionPath = path.join(root, "dist/chrome");
await mkdir(outDir, { recursive: true });

const T = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() + 1); return d.toISOString(); };
let proposals = [
  { id: "a1", title: "Dentist appointment", start: T(15), end: T(16), all_day: false, location: "12 Main St", needs_review: [], assumptions: [], source: "vision" },
  { id: "a2", title: "Spring concert", start: T(19), end: null, all_day: false, location: "School auditorium", needs_review: ["end_time"], assumptions: ["No end time given; left null rather than assuming a duration."], source: "vision" },
  { id: "a3", title: "Study group", start: T(17, 30), end: T(19), all_day: false, location: null, needs_review: ["location"], assumptions: [], source: "vision" },
];
const now = Date.now();
const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
const send = (res, s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "POST") await body(req);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (url.pathname === "/events/active") return send(res, 200, [
    { title: "Systems lecture", category: "class", busy: true, location: "Hall B", start: new Date(now - 35 * 60_000).toISOString(), end: new Date(now + 55 * 60_000).toISOString() },
  ]);
  if (url.pathname === "/proposals") return send(res, 200, { proposals });
  if (url.pathname === "/sync") return send(res, 200, { ok: true, synced: 0, reconnect: [], failed: [] });
  send(res, 404, { error: "no route" });
}).listen(PORT, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

const profile = await mkdtemp(path.join(tmpdir(), "pcc-shots-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, colorScheme: "dark", deviceScaleFactor: 2,
  viewport: { width: 380, height: 820 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
const extId = new URL(sw.url()).host;
const shot = async (page, name) => {
  await page.waitForTimeout(500); // let fonts and the last render settle
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`wrote deck/assets/${name}.png`);
};

try {
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 820 });

  // 1. The panel's own demo data: quiet during a lecture, with a day and held alerts.
  await page.goto(`chrome-extension://${extId}/ui/sidepanel.html?demo`);
  await page.waitForSelector("#timelineGutter .tick");
  await shot(page, "panel-overview");

  // 2. Suggested events.
  await sw.evaluate(() => chrome.storage.local.set({ authToken: "demo" }));
  await page.goto(`chrome-extension://${extId}/ui/sidepanel.html`);
  await page.waitForSelector("#suggestSection:not([hidden])");
  await page.evaluate(() => document.querySelector("#suggestSection")?.scrollIntoView({ block: "start" }));
  await shot(page, "panel-suggestions");

  // 3. Quick actions, with the real helper (installed into this throwaway profile only).
  if (process.platform === "darwin") {
    proposals = [];
    const nmh = path.join(profile, "NativeMessagingHosts");
    await mkdir(nmh, { recursive: true });
    execFileSync(path.join(root, "native-host/install-app-control.sh"), [extId], {
      env: { ...process.env, NMH_DIR: nmh, HELPER_DIR: path.join(profile, "helper") }, stdio: "pipe",
    });
    await sw.evaluate(() => chrome.storage.local.set({ appControl: { enabled: true, allowed: ["com.apple.calculator", "com.google.Chrome", "com.apple.Notes"] } }));
    await page.goto(`chrome-extension://${extId}/ui/sidepanel.html`);
    await page.waitForSelector("#appsSection:not([hidden])", { timeout: 10_000 });
    await page.fill("#appsInput", "open calculator");
    await shot(page, "panel-apps");
  }
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
