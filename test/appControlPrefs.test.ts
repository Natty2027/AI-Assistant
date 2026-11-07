import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAppControl, DEFAULT_APP_CONTROL } from "../src/ui/state.ts";
import { describeError, type AppError } from "../src/apps/appControl.ts";

test("app control is off, with nothing allowed, by default", () => {
  assert.deepEqual(DEFAULT_APP_CONTROL, { enabled: false, allowed: [] });
  assert.deepEqual(sanitizeAppControl(undefined), { enabled: false, allowed: [] });
  assert.deepEqual(sanitizeAppControl(null), { enabled: false, allowed: [] });
  assert.deepEqual(sanitizeAppControl("yes"), { enabled: false, allowed: [] });
});

test("only a literal true turns it on, never a truthy look-alike", () => {
  for (const v of [1, "true", "yes", {}, [], 2]) assert.equal(sanitizeAppControl({ enabled: v }).enabled, false, String(v));
  assert.equal(sanitizeAppControl({ enabled: true }).enabled, true);
});

test("a corrupted or hand-edited allow-list can only shrink, never widen", () => {
  const out = sanitizeAppControl({ enabled: true, allowed: [
    "us.zoom.xos", "us.zoom.xos", 5, null, "", "has space", 'x" to quit', "a;b", "../etc", "ok.id-1", { id: "x" }, "\n",
  ] });
  assert.deepEqual(out.allowed, ["us.zoom.xos", "ok.id-1"]);
});

test("a non-array allow-list becomes empty, and the list is capped", () => {
  assert.deepEqual(sanitizeAppControl({ enabled: true, allowed: "us.zoom.xos" }).allowed, []);
  const many = Array.from({ length: 500 }, (_, i) => `com.example.app${i}`);
  assert.equal(sanitizeAppControl({ enabled: true, allowed: many }).allowed.length, 200);
});

test("every helper error turns into a sentence a person can act on, never a raw code", () => {
  const codes: AppError[] = ["host_missing", "unsupported_platform", "permission_needed", "protected", "unknown_app",
    "bad_id", "bad_request", "unknown_op", "rate_limited", "timed_out", "failed", "disabled", "not_allowed", "confirmation_required"];
  for (const c of codes) {
    const text = describeError(c, "Zoom");
    assert.ok(text.length > 10, c);
    assert.doesNotMatch(text, /[a-z]+_[a-z]+/, `${c} leaked an internal code: ${text}`);
  }
  assert.match(describeError("permission_needed", "Zoom"), /Zoom/);
  assert.match(describeError("host_missing"), /Settings/);
  assert.match(describeError("protected", "Google Chrome"), /Google Chrome/);
  assert.ok(describeError("something-new").length > 10, "an unknown code still gets a safe message");
  assert.ok(describeError(undefined).length > 10);
});
