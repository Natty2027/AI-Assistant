/**
 * Builds every browser target from one source tree.
 *
 *   npm run build              all four targets
 *   npm run build -- firefox   just one
 *
 * Output: dist/<target>/, loadable directly in that browser.
 */
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { manifestFor, apiAliasBanner, TARGETS, type Target } from "./src/platform/manifest.ts";

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-")) as Target[];
const targets = requested.length ? requested : TARGETS;

const FONT_WEIGHTS = ["400", "500", "600", "700"];

for (const t of targets) {
  if (!TARGETS.includes(t)) throw new Error(`unknown target: ${t}`);
  const out = `dist/${t}`;
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const banner = apiAliasBanner(t);
  const apiBase = process.env.API_BASE ?? "https://api.example.com";
  await esbuild.build({
    entryPoints: {
      sw: "src/sw.ts",
      "content-signals": "src/content-signals.ts",
      "ui/panel": "src/ui/panel.ts",
      "ui/disclosure": "src/ui/disclosure.ts",
      "ui/options": "src/ui/options.ts",
    },
    bundle: true,
    format: "esm",
    target: ["chrome114", "firefox128", "safari16"],
    outdir: out,
    define: { __API_BASE__: JSON.stringify(apiBase) },
    ...(banner ? { banner: { js: banner } } : {}),
    logLevel: "warning",
  });

  // The page-world script is built on its own. It runs inside the web page's global scope, so
  // it must be an IIFE (no top-level names that could collide with, and break, the page's own
  // code) and must NOT get the `var chrome = ...` banner (that would plant a `chrome` global
  // in the page, which sites feature-detect on).
  await esbuild.build({
    entryPoints: { "content-signals-main": "src/content-signals-main.ts" },
    bundle: true,
    format: "iife",
    target: ["chrome114", "firefox128", "safari16"],
    outdir: out,
    logLevel: "warning",
  });

  await cp("ext/ui", `${out}/ui`, { recursive: true });
  await cp("ext/icons", `${out}/icons`, { recursive: true });

  // Self-hosted fonts: MV3's CSP forbids remote stylesheets/fonts, and a Google Fonts
  // dependency also draws App Store review scrutiny. Only the latin subset ships — this
  // product has no localized copy yet.
  await mkdir(`${out}/ui/fonts`, { recursive: true });
  for (const weight of FONT_WEIGHTS) {
    const file = `hanken-grotesk-latin-${weight}-normal.woff2`;
    await cp(`node_modules/@fontsource/hanken-grotesk/files/${file}`, `${out}/ui/fonts/${file}`);
  }

  const base = JSON.parse(await readFile("ext/manifest.json", "utf8"));
  if (process.env.API_BASE) {
    // Dev builds only: let the service worker reach the local mock origin.
    const origin = `${new URL(process.env.API_BASE).origin}/*`;
    base.host_permissions = [...(base.host_permissions ?? []), origin];
  }
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifestFor(t, base), null, 2));
  console.log(`built ${out}`);
}
