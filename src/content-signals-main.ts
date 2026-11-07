/**
 * Runs in the PAGE's world (manifest: world "MAIN", run_at document_start).
 *
 * This has to be page-world. A normal content script lives in an isolated world with its own
 * copies of JS objects, so wrapping navigator.mediaDevices there never intercepts the page's
 * own getDisplayMedia call; screen sharing would go undetected. The cost is that this code
 * shares a world with the page, so it has no extension APIs and reports over postMessage to
 * content-signals.ts, which relays to the service worker.
 *
 * Reports booleans only. Never stream contents, never page text.
 */

import { SignalTracker } from "./ambient/signalTracker";

const MARK = "__pcc_signals__";

const tracker = new SignalTracker((s) => {
  window.postMessage({ [MARK]: true, screenSharing: s.screenSharing, micActive: s.micActive }, "*");
});

const md = navigator.mediaDevices;

if (md?.getDisplayMedia) {
  const orig = md.getDisplayMedia;
  md.getDisplayMedia = async function (this: MediaDevices, ...args: Parameters<typeof orig>) {
    const stream: MediaStream = await orig.apply(this, args);
    // The video track is the screen. Any audio here is tab/system audio, not the microphone.
    stream.getVideoTracks().forEach((t) => tracker.addScreen(t));
    return stream;
  };
}

if (md?.getUserMedia) {
  const orig = md.getUserMedia;
  md.getUserMedia = async function (this: MediaDevices, ...args: Parameters<typeof orig>) {
    const stream: MediaStream = await orig.apply(this, args);
    stream.getAudioTracks().forEach((t) => tracker.addMic(t));
    return stream;
  };
}

if (typeof MediaStreamTrack !== "undefined") {
  // stop() fires no 'ended' event, so patch it. This is how every call app's Stop button works.
  const origStop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function (this: MediaStreamTrack) {
    tracker.release(this);
    return origStop.call(this);
  };

  const origClone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function (this: MediaStreamTrack) {
    const copy = origClone.call(this);
    tracker.adoptClone(this, copy);
    return copy;
  };
}
