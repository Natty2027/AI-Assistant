import test from "node:test";
import assert from "node:assert/strict";
import { badgeFor } from "../src/ambient/badge.ts";
import type { QuietVerdict } from "../src/ambient/quietMode.ts";

const verdict = (level: QuietVerdict["level"]): QuietVerdict =>
  ({ level, source: "default", reason: "", until: null, inferred: false });

test("no held alerts means no badge text, regardless of level", () => {
  assert.equal(badgeFor(verdict("full"), 0).text, "");
  assert.equal(badgeFor(verdict("silent"), 0).text, "");
});

test("held count shows as text up to 9", () => {
  assert.equal(badgeFor(verdict("silent"), 3).text, "3");
  assert.equal(badgeFor(verdict("silent"), 9).text, "9");
});

test("held count caps the displayed text at 9+", () => {
  assert.equal(badgeFor(verdict("silent"), 10).text, "9+");
  assert.equal(badgeFor(verdict("silent"), 142).text, "9+");
});

test("color follows quiet level, independent of count", () => {
  const full = badgeFor(verdict("full"), 0).color;
  const visual = badgeFor(verdict("visual_only"), 0).color;
  const silent = badgeFor(verdict("silent"), 0).color;
  assert.notEqual(full, visual);
  assert.notEqual(visual, silent);
  assert.notEqual(full, silent);
  // Color must not depend on the held count — only the level.
  assert.equal(badgeFor(verdict("silent"), 0).color, badgeFor(verdict("silent"), 5).color);
});
