import test from "node:test";
import assert from "node:assert/strict";
import { quietHoursWindow } from "../src/ambient/quietHours.ts";

test("disabled settings never resolve active, regardless of clock", () => {
  const r = quietHoursWindow(new Date("2026-03-02T23:30:00"), { enabled: false, start: "22:00", end: "07:00" });
  assert.equal(r.active, false);
  assert.equal(r.until, null);
});

test("zero-length window (start === end) is treated as off, not always-on", () => {
  const r = quietHoursWindow(new Date("2026-03-02T23:30:00"), { enabled: true, start: "09:00", end: "09:00" });
  assert.equal(r.active, false);
});

test("non-wrapping window: active inside, inactive outside", () => {
  const settings = { enabled: true, start: "09:00", end: "17:00" };
  const inside = quietHoursWindow(new Date("2026-03-02T12:00:00"), settings);
  assert.equal(inside.active, true);
  assert.equal(inside.until!.getHours(), 17);
  assert.equal(inside.until!.getDate(), 2, "end lands the same day");

  const before = quietHoursWindow(new Date("2026-03-02T08:00:00"), settings);
  assert.equal(before.active, false);

  const after = quietHoursWindow(new Date("2026-03-02T18:00:00"), settings);
  assert.equal(after.active, false);
});

test("midnight-wrapping window, evening side: active, until lands tomorrow", () => {
  const settings = { enabled: true, start: "22:00", end: "07:00" };
  const r = quietHoursWindow(new Date("2026-03-02T23:30:00"), settings);
  assert.equal(r.active, true);
  assert.equal(r.until!.getDate(), 3, "end time must roll to the next calendar day");
  assert.equal(r.until!.getHours(), 7);
  assert.equal(r.until!.getMinutes(), 0);
});

test("midnight-wrapping window, early-morning side: active, until stays today", () => {
  const settings = { enabled: true, start: "22:00", end: "07:00" };
  const r = quietHoursWindow(new Date("2026-03-03T05:15:00"), settings);
  assert.equal(r.active, true);
  assert.equal(r.until!.getDate(), 3, "end time is later the same day");
  assert.equal(r.until!.getHours(), 7);
});

test("midnight-wrapping window, outside the window: inactive", () => {
  const settings = { enabled: true, start: "22:00", end: "07:00" };
  const r = quietHoursWindow(new Date("2026-03-03T12:00:00"), settings);
  assert.equal(r.active, false);
  assert.equal(r.until, null);
});

test("boundary: exactly at start is active, exactly at end is not (half-open interval)", () => {
  const settings = { enabled: true, start: "22:00", end: "07:00" };
  assert.equal(quietHoursWindow(new Date("2026-03-02T22:00:00"), settings).active, true);
  assert.equal(quietHoursWindow(new Date("2026-03-03T07:00:00"), settings).active, false);
});
