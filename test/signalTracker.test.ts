import { test } from "node:test";
import assert from "node:assert/strict";
import { SignalTracker, type Signals, type TrackLike } from "../src/ambient/signalTracker.ts";

/** A stand-in for MediaStreamTrack: records its 'ended' listener so a test can fire it. */
function fakeTrack(): TrackLike & { end(): void } {
  const listeners: Array<() => void> = [];
  return {
    addEventListener: (_t, cb) => { listeners.push(cb); },
    end: () => listeners.forEach((l) => l()),
  };
}

function make() {
  const events: Signals[] = [];
  const tracker = new SignalTracker((s) => events.push(s));
  return { tracker, events };
}

test("starts with nothing live", () => {
  assert.deepEqual(make().tracker.state(), { screenSharing: false, micActive: false });
});

test("a screen track turns sharing on, and the browser ending it turns it off", () => {
  const { tracker, events } = make();
  const t = fakeTrack();
  tracker.addScreen(t);
  assert.equal(tracker.state().screenSharing, true);
  t.end();
  assert.equal(tracker.state().screenSharing, false);
  assert.deepEqual(events.map((e) => e.screenSharing), [true, false]);
});

test("track.stop() releases the track even though no 'ended' event fires", () => {
  const { tracker } = make();
  const t = fakeTrack();
  tracker.addMic(t);
  assert.equal(tracker.state().micActive, true);
  tracker.release(t); // what the patched stop() calls
  assert.equal(tracker.state().micActive, false);
});

test("sharing and mic are independent", () => {
  const { tracker } = make();
  const screen = fakeTrack(), mic = fakeTrack();
  tracker.addScreen(screen);
  tracker.addMic(mic);
  tracker.release(screen);
  assert.deepEqual(tracker.state(), { screenSharing: false, micActive: true });
});

test("two screen tracks keep sharing on until both are gone", () => {
  const { tracker } = make();
  const a = fakeTrack(), b = fakeTrack();
  tracker.addScreen(a);
  tracker.addScreen(b);
  tracker.release(a);
  assert.equal(tracker.state().screenSharing, true);
  tracker.release(b);
  assert.equal(tracker.state().screenSharing, false);
});

test("stopping the original does not end sharing while a clone is still live", () => {
  const { tracker } = make();
  const original = fakeTrack(), clone = fakeTrack();
  tracker.addScreen(original);
  tracker.adoptClone(original, clone);
  tracker.release(original);
  assert.equal(tracker.state().screenSharing, true);
  tracker.release(clone);
  assert.equal(tracker.state().screenSharing, false);
});

test("a clone of an untracked track is ignored", () => {
  const { tracker } = make();
  tracker.adoptClone(fakeTrack(), fakeTrack());
  assert.deepEqual(tracker.state(), { screenSharing: false, micActive: false });
});

test("only real changes are reported", () => {
  const { tracker, events } = make();
  const a = fakeTrack(), b = fakeTrack();
  tracker.addScreen(a);
  tracker.addScreen(b);          // still just "sharing": no new event
  tracker.release(a);            // still sharing: no new event
  tracker.release(a);            // already gone: no new event
  tracker.release(b);            // now off
  assert.equal(events.length, 2);
});

test("releasing a track that was never tracked is harmless", () => {
  const { tracker, events } = make();
  tracker.release(fakeTrack());
  assert.equal(events.length, 0);
});
