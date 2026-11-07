import test from "node:test";
import assert from "node:assert/strict";
import {
  manifestFor, apiAliasBanner, panelSurface, isChromium, TARGETS,
  type BuildManifest, type Target,
} from "../src/platform/manifest.ts";

const base: BuildManifest = {
  manifest_version: 3,
  name: "Ambient Cyber Companion",
  version: "0.1.0",
  permissions: ["sidePanel", "storage", "alarms", "idle", "contextMenus", "identity", "nativeMessaging"],
  background: { service_worker: "sw.js", type: "module" },
  side_panel: { default_path: "ui/sidepanel.html" },
  action: { default_title: "Ambient Cyber Companion" },
  commands: {
    _execute_action: { suggested_key: { default: "Alt+Shift+C" }, description: "Open the panel" },
    "toggle-mute": { suggested_key: { default: "Alt+Shift+M" }, description: "Mute or unmute" },
  },
  _safari_notes: ["internal"],
};

test("every target produces a valid MV3 manifest with a background and an action", () => {
  for (const t of TARGETS) {
    const m = manifestFor(t, base);
    assert.equal(m.manifest_version, 3, t);
    assert.ok(m.background, `${t} has no background`);
    assert.ok(m.action, `${t} has no action`);
    assert.ok(m.content_scripts?.length, `${t} missing content script`);
    assert.equal(m._safari_notes, undefined, `${t} leaked internal notes`);
  }
});

test("page-world signal script ships on Chromium and Firefox, with the relay beside it", () => {
  for (const t of ["chrome", "edge", "firefox"] as Target[]) {
    const scripts = manifestFor(t, base).content_scripts as Array<{ js: string[]; world?: string; run_at: string }>;
    const main = scripts.find((s) => s.world === "MAIN");
    assert.ok(main, `${t} needs a MAIN-world script: the isolated world cannot see the page's getUserMedia`);
    assert.deepEqual(main.js, ["content-signals-main.js"], t);
    assert.equal(main.run_at, "document_start", `${t}: wrappers must exist before page scripts run`);
    assert.ok(scripts.some((s) => !s.world && s.js.includes("content-signals.js")), `${t} lacks the relay`);
  }
});

test("Safari ships only the relay, since MAIN-world support is unconfirmed there", () => {
  const scripts = manifestFor("safari", base).content_scripts as Array<{ js: string[]; world?: string }>;
  assert.ok(scripts.length > 0);
  assert.ok(scripts.every((s) => s.world !== "MAIN"));
});

test("only Chromium keeps service_worker; the others would silently no-op", () => {
  for (const t of TARGETS) {
    const bg = manifestFor(t, base).background as any;
    if (isChromium(t)) assert.equal(bg.service_worker, "sw.js", t);
    else {
      assert.equal(bg.service_worker, undefined, `${t} must not use service_worker`);
      assert.deepEqual(bg.scripts, ["sw.js"], t);
    }
  }
});

test("side_panel survives only on Chromium", () => {
  assert.ok(manifestFor("chrome", base).side_panel);
  assert.ok(manifestFor("edge", base).side_panel);
  assert.equal(manifestFor("firefox", base).side_panel, undefined);
  assert.equal(manifestFor("safari", base).side_panel, undefined);
});

test("Firefox gets a sidebar and drops the sidePanel permission", () => {
  const m = manifestFor("firefox", base);
  assert.equal((m.sidebar_action as any).default_panel, "ui/sidepanel.html");
  assert.ok(!m.permissions.includes("sidePanel"));
});

test("Firefox declares a gecko id, without which it will not install", () => {
  const g = (manifestFor("firefox", base).browser_specific_settings as any).gecko;
  assert.ok(g.id.includes("@"), "gecko id must look like an email/uuid");
  assert.ok(g.strict_min_version);
});

test("Safari falls back to a popup and drops native messaging", () => {
  const m = manifestFor("safari", base);
  assert.equal((m.action as any).default_popup, "ui/sidepanel.html");
  assert.ok(!m.permissions.includes("nativeMessaging"), "Safari has no host-manifest path");
  assert.ok(!m.permissions.includes("sidePanel"));
});

test("Chromium keeps nativeMessaging so the Focus probe can run", () => {
  assert.ok(manifestFor("chrome", base).permissions.includes("nativeMessaging"));
  assert.ok(manifestFor("firefox", base).permissions.includes("nativeMessaging"));
});

test("the base manifest is never mutated across builds", () => {
  const before = JSON.stringify(base);
  TARGETS.forEach((t) => manifestFor(t, base));
  assert.equal(JSON.stringify(base), before, "transform mutated its input");
});

test("non-Chromium bundles get the browser/chrome alias", () => {
  assert.equal(apiAliasBanner("chrome"), undefined);
  assert.equal(apiAliasBanner("edge"), undefined);
  for (const t of ["firefox", "safari"] as Target[]) {
    assert.match(apiAliasBanner(t)!, /globalThis\.browser/, t);
  }
});

test("panel surface is reported correctly per engine", () => {
  assert.equal(panelSurface("chrome"), "side_panel");
  assert.equal(panelSurface("edge"), "side_panel");
  assert.equal(panelSurface("firefox"), "sidebar");
  assert.equal(panelSurface("safari"), "popup");
});

test("Chromium and Safari keep _execute_action unchanged", () => {
  for (const t of ["chrome", "edge", "safari"] as Target[]) {
    const commands = manifestFor(t, base).commands as Record<string, unknown>;
    assert.ok("_execute_action" in commands, t);
    assert.ok(!("_execute_sidebar_action" in commands), t);
  }
});

test("Firefox renames _execute_action to _execute_sidebar_action, since it has no action popup", () => {
  const commands = manifestFor("firefox", base).commands as Record<string, unknown>;
  assert.ok(!("_execute_action" in commands), "the Chromium-only name must not survive");
  assert.ok("_execute_sidebar_action" in commands);
  assert.deepEqual(
    (commands["_execute_sidebar_action"] as any).suggested_key,
    { default: "Alt+Shift+C" }
  );
});

test("Firefox rename preserves other, unrelated commands untouched", () => {
  const commands = manifestFor("firefox", base).commands as Record<string, unknown>;
  assert.ok("toggle-mute" in commands);
  assert.deepEqual((commands["toggle-mute"] as any).suggested_key, { default: "Alt+Shift+M" });
});

test("manifestFor tolerates a base with no commands key at all", () => {
  const { commands, ...noCommands } = base;
  for (const t of TARGETS) {
    assert.doesNotThrow(() => manifestFor(t, noCommands as BuildManifest), t);
  }
});

test("an unknown key in the base manifest is carried through untouched", () => {
  const m = manifestFor("firefox", { ...base, host_permissions: ["https://x.example/*"] });
  assert.deepEqual(m.host_permissions, ["https://x.example/*"]);
});
