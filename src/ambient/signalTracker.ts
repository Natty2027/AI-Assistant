/**
 * Tracks which capture tracks are live, so "screen sharing" and "mic on" reflect reality.
 *
 * The browser gives no event when a page calls `track.stop()` (the 'ended' event only fires
 * when the BROWSER ends a track, e.g. the user clicks its own "Stop sharing" bar). Meet, Zoom
 * and Teams stop capture with their own buttons, which is stop(). So the page-world script
 * also patches stop() and feeds it here; without that, "sharing" stays true forever after the
 * first call and the assistant would be silent for the rest of the session.
 *
 * Pure and free of browser globals so it can be tested with plain objects.
 */

export interface TrackLike {
  addEventListener(type: "ended", cb: () => void): void;
}

export interface Signals {
  screenSharing: boolean;
  micActive: boolean;
}

export class SignalTracker {
  private screen = new Set<TrackLike>();
  private mic = new Set<TrackLike>();
  private last: Signals = { screenSharing: false, micActive: false };

  constructor(private readonly onChange: (s: Signals) => void) {}

  state(): Signals {
    return { screenSharing: this.screen.size > 0, micActive: this.mic.size > 0 };
  }

  addScreen(t: TrackLike): void { this.add(this.screen, t); }
  addMic(t: TrackLike): void { this.add(this.mic, t); }

  /** A clone is a second handle on the same capture; stopping the original must not end it. */
  adoptClone(original: TrackLike, clone: TrackLike): void {
    if (this.screen.has(original)) this.add(this.screen, clone);
    if (this.mic.has(original)) this.add(this.mic, clone);
  }

  /** Called when a track ends or is stopped, by either route. Safe to call repeatedly. */
  release(t: TrackLike): void {
    const changed = this.screen.delete(t) || this.mic.delete(t);
    if (changed) this.emit();
  }

  private add(set: Set<TrackLike>, t: TrackLike): void {
    if (set.has(t)) return;
    set.add(t);
    t.addEventListener("ended", () => this.release(t));
    this.emit();
  }

  /** Only report real changes, so a page that churns tracks does not spam the worker. */
  private emit(): void {
    const next = this.state();
    if (next.screenSharing === this.last.screenSharing && next.micActive === this.last.micActive) return;
    this.last = next;
    this.onChange(next);
  }
}
