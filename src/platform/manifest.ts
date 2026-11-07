/**
 * Per-browser manifest transforms.
 *
 * A pure function rather than branches inside the build script, so the differences between
 * four browsers are visible in one place and covered by tests. Each of these was a real
 * silent-load-failure at some point: Firefox rejects `service_worker`, Safari rejects
 * `side_panel`, and Firefox refuses to install without a gecko id.
 */

export type Target = "chrome" | "edge" | "firefox" | "safari";

export const TARGETS: Target[] = ["chrome", "edge", "firefox", "safari"];

/** Chromium targets share one build; only the store listing differs. */
export const isChromium = (t: Target) => t === "chrome" || t === "edge";

export interface BuildManifest {
  manifest_version: number;
  name: string;
  version: string;
  permissions: string[];
  background?: Record<string, unknown>;
  side_panel?: { default_path: string };
  sidebar_action?: Record<string, unknown>;
  action: Record<string, unknown>;
  content_scripts?: unknown[];
  browser_specific_settings?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  [k: string]: unknown;
}

const GECKO_ID = "ambient-companion@yourorg.example";

export function manifestFor(target: Target, base: BuildManifest): BuildManifest {
  const m: BuildManifest = JSON.parse(JSON.stringify(base));
  delete m._safari_notes;

  m.content_scripts = [
    // Page world: the only place getDisplayMedia/getUserMedia can actually be observed.
    // document_start so the wrappers are in place before any page script can call them.
    {
      matches: ["<all_urls>"],
      js: ["content-signals-main.js"],
      run_at: "document_start",
      all_frames: false,
      world: "MAIN",
    },
    // Isolated world: owns the extension API and relays what the page-world script reports.
    {
      matches: ["<all_urls>"],
      js: ["content-signals.js"],
      run_at: "document_start",
      all_frames: false,
    },
  ];

  if (isChromium(target)) return m; // the reference shape

  if (target === "firefox") {
    // Firefox MV3 uses non-persistent event pages, not service workers. Shipping
    // `service_worker` makes the extension install and then do nothing at all.
    m.background = { scripts: ["sw.js"], type: "module" };

    // No sidePanel API; the equivalent is sidebarAction, which is a top-level key.
    delete m.side_panel;
    m.sidebar_action = {
      default_panel: "ui/sidepanel.html",
      default_title: base.name,
      default_icon: { 48: "icons/48.png" },
      open_at_install: false,
    };
    m.permissions = m.permissions.filter((p) => p !== "sidePanel");

    // AMO refuses to install an unsigned MV3 extension without an explicit id.
    m.browser_specific_settings = {
      gecko: { id: GECKO_ID, strict_min_version: "128.0" },
    };

    // `_execute_action` is the reserved command name for the toolbar-button shortcut, but
    // Firefox's panel surface is the sidebar, not the action popup — under the Chromium name
    // the shortcut silently does nothing.
    if (m.commands && typeof m.commands === "object") {
      const commands = m.commands as Record<string, unknown>;
      if ("_execute_action" in commands) {
        const { _execute_action, ...rest } = commands;
        m.commands = { _execute_sidebar_action: _execute_action, ...rest };
      }
    }
    return m;
  }

  // safari
  m.background = { scripts: ["sw.js"], type: "module", persistent: false };
  delete m.side_panel;
  m.action = { ...m.action, default_popup: "ui/sidepanel.html" };
  // Native messaging on Safari goes through the containing app, not a host manifest.
  // quietMode's probe already treats an absent host as "no signal" and fails quiet.
  m.permissions = m.permissions.filter((p) => p !== "sidePanel" && p !== "nativeMessaging");
  // Not confirmed: whether Safari honours `world: "MAIN"`. Shipping an unsupported key risks the
  // whole content-script block being ignored, so Safari keeps only the relay and reports no
  // screen-share/mic signal, which resolves quiet (the safe direction) rather than wrong.
  m.content_scripts = (m.content_scripts ?? []).filter((c) => (c as { world?: string }).world !== "MAIN");
  return m;
}

/** Prepended to bundles for engines that expose `browser` rather than `chrome`. */
export function apiAliasBanner(target: Target): string | undefined {
  if (isChromium(target)) return undefined;
  return "var chrome = globalThis.chrome ?? globalThis.browser;";
}

/** Where the panel actually lives, for the UI to adapt its own chrome. */
export function panelSurface(target: Target): "side_panel" | "sidebar" | "popup" {
  if (isChromium(target)) return "side_panel";
  return target === "firefox" ? "sidebar" : "popup";
}
