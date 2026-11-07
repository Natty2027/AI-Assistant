import { test } from "node:test";
import assert from "node:assert/strict";
import { fromLocalInput, toLocalInput } from "../src/ui/localTime.ts";

/** Run a body under a specific timezone; Node re-reads TZ when it is assigned. */
function inZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}

test("what the user types is read as their own wall-clock time, not UTC", () => {
  // 7:00 PM in Los Angeles in November is 03:00 UTC the next day. Reading it as UTC would put
  // the event at 11am local: the exact failure this helper exists to prevent.
  inZone("America/Los_Angeles", () => {
    assert.equal(fromLocalInput("2026-11-10T19:00"), "2026-11-11T03:00:00.000Z");
  });
  inZone("Asia/Tokyo", () => {
    assert.equal(fromLocalInput("2026-11-10T19:00"), "2026-11-10T10:00:00.000Z");
  });
});

test("an instant is shown back in local time", () => {
  inZone("America/Los_Angeles", () => assert.equal(toLocalInput("2026-11-11T03:00:00.000Z"), "2026-11-10T19:00"));
  inZone("Asia/Tokyo", () => assert.equal(toLocalInput("2026-11-10T10:00:00.000Z"), "2026-11-10T19:00"));
});

test("a value survives a round trip in several zones", () => {
  for (const tz of ["UTC", "America/New_York", "Europe/London", "Asia/Kolkata", "Pacific/Auckland"]) {
    inZone(tz, () => {
      const iso = "2026-03-08T18:30:00.000Z";
      assert.equal(fromLocalInput(toLocalInput(iso)), iso, tz);
    });
  }
});

test("blank, malformed and impossible values become null / empty, never an exception", () => {
  assert.equal(fromLocalInput(""), null);
  assert.equal(fromLocalInput(null), null);
  assert.equal(fromLocalInput("tomorrow"), null);
  assert.equal(fromLocalInput("2026-13-45T99:99"), null);
  assert.equal(fromLocalInput("2026-11-10T19:00:00Z"), null, "a zone suffix is not what a datetime-local input produces");
  assert.equal(toLocalInput(null), "");
  assert.equal(toLocalInput("garbage"), "");
});
