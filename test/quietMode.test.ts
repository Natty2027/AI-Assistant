import test from "node:test";
import assert from "node:assert/strict";
import { QuietModeEngine, routeAlert, flushQueue, offlineFallbackEvents, type ActiveEvent, type Alert, type AlertSinks } from "../src/ambient/quietMode.ts";

const NOW = new Date("2026-03-02T14:12:00Z");
const ev = (o: Partial<ActiveEvent>): ActiveEvent => ({
  title: "x", category: "meeting", busy: true,
  start: new Date(NOW.getTime() - 600_000), end: new Date(NOW.getTime() + 600_000), ...o,
});
const noMute = async () => ({ muted: false, until: null });
const engine = (events: ActiveEvent[], mute = noMute) =>
  new QuietModeEngine(async () => events, mute);

test("no OS access and no signals => fails quiet, not loud", async () => {
  const v = await engine([]).resolve(NOW);
  assert.equal(v.level, "visual_only");
  assert.equal(v.inferred, true);
});

test("exam wins over an ordinary busy meeting", async () => {
  const v = await engine([ev({ category: "meeting" }), ev({ category: "exam" })]).resolve(NOW);
  assert.equal(v.level, "silent");
  assert.equal(v.source, "calendar_exam");
});

test("manual mute produces silence with its own reason", async () => {
  const until = new Date(NOW.getTime() + 3_600_000);
  const v = await engine([], async () => ({ muted: true, until })).resolve(NOW);
  assert.equal(v.level, "silent");
  assert.equal(v.source, "manual");
  assert.match(v.reason, /Muted until/);
});

test("an event that already ended does not silence anything", async () => {
  const past = ev({ start: new Date(NOW.getTime() - 7200_000), end: new Date(NOW.getTime() - 3600_000) });
  const v = await engine([past]).resolve(NOW);
  assert.notEqual(v.source, "calendar_busy");
});

test("an event that has not started yet does not silence anything", async () => {
  const future = ev({ start: new Date(NOW.getTime() + 3600_000), end: new Date(NOW.getTime() + 7200_000) });
  const v = await engine([future]).resolve(NOW);
  assert.notEqual(v.source, "calendar_busy");
});

test("a free/transparent event does not silence anything", async () => {
  const v = await engine([ev({ busy: false, category: "other" })]).resolve(NOW);
  assert.notEqual(v.source, "calendar_busy");
});

test("free-marked EXAM still silences — busy flag must not override category", async () => {
  const v = await engine([ev({ busy: false, category: "exam" })]).resolve(NOW);
  assert.equal(v.source, "calendar_exam");
  assert.equal(v.level, "silent");
});

test("tightening is immediate", async () => {
  const e = engine([]);
  await e.resolve(NOW);
  const e2 = new QuietModeEngine(async () => [ev({ category: "exam" })], noMute);
  await e2.resolve(NOW);
  const v = await e2.resolve(new Date(NOW.getTime() + 1000));
  assert.equal(v.level, "silent");
});

test("loosening waits out the dwell window", async () => {
  let events: ActiveEvent[] = [ev({ category: "class" })];
  const e = new QuietModeEngine(async () => events, noMute);
  const first = await e.resolve(NOW);
  assert.equal(first.level, "silent");

  events = [];
  const tooSoon = await e.resolve(new Date(NOW.getTime() + 30_000));
  assert.equal(tooSoon.level, "silent", "must not un-mute 30s after a class ends");

  const later = await e.resolve(new Date(NOW.getTime() + 120_000));
  assert.equal(later.level, "visual_only");
});

/* ---------------- quiet hours ---------------- */

test("quiet hours silences even with no calendar or OS evidence at all", async () => {
  const e = new QuietModeEngine(
    async () => [], noMute, async () => ({ screenSharing: false, micActive: false }),
    async () => ({ enabled: true, start: "00:00", end: "23:59" })
  );
  const v = await e.resolve(NOW);
  assert.equal(v.level, "silent");
  assert.equal(v.source, "quiet_hours");
});

test("an active exam still outranks quiet hours", async () => {
  const e = new QuietModeEngine(
    async () => [ev({ category: "exam" })], noMute,
    async () => ({ screenSharing: false, micActive: false }),
    async () => ({ enabled: true, start: "00:00", end: "23:59" })
  );
  const v = await e.resolve(NOW);
  assert.equal(v.source, "calendar_exam");
});

test("quiet hours outranks OS Focus when both resolve silent", async () => {
  await withNativeHostPresentFocusOn(async () => {
    const e = new QuietModeEngine(
      async () => [], noMute, async () => ({ screenSharing: false, micActive: false }),
      async () => ({ enabled: true, start: "00:00", end: "23:59" })
    );
    const v = await e.resolve(NOW);
    assert.equal(v.source, "quiet_hours");
  });
});

test("disabled quiet hours contribute nothing", async () => {
  const e = new QuietModeEngine(
    async () => [], noMute, async () => ({ screenSharing: false, micActive: false }),
    async () => ({ enabled: false, start: "00:00", end: "23:59" })
  );
  const v = await e.resolve(NOW);
  assert.notEqual(v.source, "quiet_hours");
});

/* ---------------- alert routing ---------------- */

function sinks() {
  const log: string[] = [];
  const s: AlertSinks = {
    playChime: () => log.push("chime"),
    speak: () => log.push("speak"),
    showOverlay: () => log.push("overlay"),
    updatePanel: () => log.push("panel"),
    enqueue: () => log.push("queue"),
  };
  return { s, log };
}
const alert = (o: Partial<Alert> = {}): Alert =>
  ({ id: "a", text: "t", scheduledFor: NOW, ...o });

test("silent level queues everything", () => {
  const { s, log } = sinks();
  routeAlert(alert(), { level: "silent", source: "calendar_exam", reason: "", until: null, inferred: false }, s);
  assert.deepEqual(log, ["queue"]);
});

test("visual_only never makes sound", () => {
  const { s, log } = sinks();
  routeAlert(alert(), { level: "visual_only", source: "fullscreen", reason: "", until: null, inferred: true }, s);
  assert.deepEqual(log, ["panel"]);
});

test("crisis alert surfaces during an exam, and surfaces silently", () => {
  const { s, log } = sinks();
  routeAlert(alert({ bypassQuiet: true }),
    { level: "silent", source: "calendar_exam", reason: "", until: null, inferred: false }, s);
  assert.ok(log.includes("panel"), "crisis must reach the panel");
  assert.ok(log.includes("overlay"), "crisis must be visible");
  assert.ok(!log.includes("chime"), "crisis must not chime");
  assert.ok(!log.includes("speak"), "crisis must not read aloud");
  assert.ok(!log.includes("queue"), "crisis must never be queued");
});

test("crisis alert also silent under manual mute", () => {
  const { s, log } = sinks();
  routeAlert(alert({ bypassQuiet: true }),
    { level: "silent", source: "manual", reason: "", until: null, inferred: false }, s);
  assert.ok(log.includes("panel"));
});

test("flush batches instead of firing a burst of chimes", () => {
  const { s, log } = sinks();
  const q = [alert({ id: "1" }), alert({ id: "2" }), alert({ id: "3" })];
  const out = flushQueue(q, s);
  assert.match(out!.text, /3 things/);
  assert.equal(log.filter((x) => x === "chime").length, 1);
  assert.equal(q.length, 0);
});

test("flushing an empty queue is a no-op", () => {
  const { s, log } = sinks();
  assert.equal(flushQueue([], s), null);
  assert.deepEqual(log, []);
});

/* ---------------- offline fail-quiet (see sw.ts getActiveEvents) ---------------- */

// Simulate a machine where a native Focus host IS installed but Focus is currently off.
// probeNativeFocus() then returns { active: false } (non-null), which suppresses the
// resolver's "no OS access" default. With no other evidence, that is the exact condition
// under which an empty event list resolves LOUD — the failure the offline fallback prevents.
async function withNativeHostPresent<T>(fn: () => Promise<T>): Promise<T> {
  const prior = (globalThis as unknown as { chrome?: unknown }).chrome;
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendNativeMessage: (_host: string, _msg: unknown, cb: (r: unknown) => void) =>
        cb({ focus_active: false }),
    },
  };
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete (globalThis as unknown as { chrome?: unknown }).chrome;
    else (globalThis as unknown as { chrome?: unknown }).chrome = prior;
  }
}

async function withNativeHostPresentFocusOn<T>(fn: () => Promise<T>): Promise<T> {
  const prior = (globalThis as unknown as { chrome?: unknown }).chrome;
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendNativeMessage: (_host: string, _msg: unknown, cb: (r: unknown) => void) =>
        cb({ focus_active: true, mode_name: "Focus" }),
    },
  };
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete (globalThis as unknown as { chrome?: unknown }).chrome;
    else (globalThis as unknown as { chrome?: unknown }).chrome = prior;
  }
}

test("offlineFallbackEvents is a currently-active, busy, non-exam block", () => {
  const [b] = offlineFallbackEvents(NOW);
  assert.equal(b.busy, true);
  assert.notEqual(b.category, "exam");
  assert.ok(b.start <= NOW && b.end > NOW, "must overlap now so the resolver counts it");
});

test("offline + native Focus host present => resolver stays quiet, never loud", async () => {
  await withNativeHostPresent(async () => {
    const v = await engine(offlineFallbackEvents(NOW)).resolve(NOW);
    assert.equal(v.level, "silent");
    assert.equal(v.source, "calendar_busy");
  });
});

test("regression: an EMPTY list with a native host present resolves loud (why the fallback exists)", async () => {
  // If this ever stops being "full", the offline fallback may no longer be load-bearing —
  // revisit sw.ts getActiveEvents before deleting it.
  await withNativeHostPresent(async () => {
    const v = await engine([]).resolve(NOW);
    assert.equal(v.level, "full");
  });
});
