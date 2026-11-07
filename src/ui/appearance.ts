/**
 * Theme/gradient resolution, shared by all three UI pages. "auto" is always resolved to a
 * concrete "light"/"dark" value here before it reaches the DOM, so theme.css never has to
 * handle "auto" itself or race a media query.
 */

import { loadSettings, onSettingsChanged, type Settings } from "./state";

function resolveTheme(settings: Settings): "light" | "dark" {
  if (settings.theme !== "auto") return settings.theme;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function apply(settings: Settings): void {
  document.body.dataset.theme = resolveTheme(settings);
  document.body.dataset.gradient = settings.gradient;
}

/**
 * Resolves and applies the theme/gradient once, then keeps it in sync with OS preference
 * changes and with settings edited from another page (e.g. the options tab, while the panel
 * is open elsewhere).
 *
 * `?theme=light` / `?theme=dark` in the URL forces a theme for this page load only — doesn't
 * touch stored settings. Lets anyone preview both themes without changing their OS setting,
 * and is how scripts/preview.mjs screenshots both for review.
 */
export async function initAppearance(): Promise<void> {
  const forced = new URLSearchParams(location.search).get("theme");
  if (forced === "light" || forced === "dark") {
    apply({ ...(await loadSettings()), theme: forced });
    return;
  }
  apply(await loadSettings());
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", async () => apply(await loadSettings()));
  onSettingsChanged(apply);
}
