/**
 * Toolbar badge — the ambient-presence signal visible without opening the panel. A color
 * carries the quiet level (sage = full, sand = visual-only, slate = silent); the count,
 * when non-zero, is the only text. Pure function so the mapping is tested without a browser.
 */

import type { QuietVerdict } from "./quietMode";

export interface Badge {
  text: string;
  color: string;
}

const COLOR_FULL = "#7FA8A0"; // sage — matches the panel's "listening" accent
const COLOR_VISUAL_ONLY = "#C8A98A"; // sand
const COLOR_SILENT = "#6E747E"; // faint

export function badgeFor(verdict: QuietVerdict, heldCount: number): Badge {
  const color =
    verdict.level === "full" ? COLOR_FULL
    : verdict.level === "visual_only" ? COLOR_VISUAL_ONLY
    : COLOR_SILENT;

  const text = heldCount <= 0 ? "" : heldCount > 9 ? "9+" : String(heldCount);

  return { text, color };
}
