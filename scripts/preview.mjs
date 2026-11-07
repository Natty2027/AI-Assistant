/**
 * Loads the built extension at its real chrome-extension:// origin and screenshots the three
 * UI pages in both themes. Google Chrome's official build blocks the `--load-extension` CLI
 * flag, so this uses Playwright's own Chromium instead — the standard way to drive an
 * unpacked MV3 extension headlessly.
 *
 * Usage:
 *   npm run build:mock && node scripts/preview.mjs
 *   node scripts/preview.mjs --headed     # watch it instead of just saving PNGs
 *
 * Output: screenshots/*.png (gitignored scratch dir).
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const extensionPath = path.join(root, "dist/chrome");
const outDir = path.join(root, "screenshots");
const headed = process.argv.includes("--headed");

await mkdir(outDir, { recursive: true });

const userDataDir = path.join(root, ".preview-profile");
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: !headed,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

// MV3 extensions run their background as a service worker, not a page — grab its URL to
// read off the extension ID Chrome assigned this unpacked build.
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10_000 });
const extensionId = new URL(sw.url()).host;
console.log(`extension id: ${extensionId}`);

async function shoot(name, urlPath, { theme } = {}) {
  const page = await context.newPage();
  const sep = urlPath.includes("?") ? "&" : "?";
  const qs = theme ? `${sep}theme=${theme}` : "";
  await page.goto(`chrome-extension://${extensionId}/${urlPath}${qs}`);
  await page.waitForTimeout(400); // let the module script finish its first render
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  await page.close();
  console.log(`saved screenshots/${name}.png`);
}

await shoot("panel-dark", "ui/sidepanel.html", { theme: "dark" });
await shoot("panel-light", "ui/sidepanel.html", { theme: "light" });
await shoot("options-dark", "ui/options.html", { theme: "dark" });
await shoot("disclosure-google-dark", "ui/connect-disclosure.html?provider=google", { theme: "dark" });
await shoot("disclosure-canvas-dark", "ui/connect-disclosure.html?provider=canvas_ical", { theme: "dark" });

if (headed) {
  console.log("Headed mode — leaving the window open. Ctrl-C to quit.");
} else {
  await context.close();
}
