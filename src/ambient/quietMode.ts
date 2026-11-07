/**
 * DELIVERABLE 2 — quiet-mode arbitration.
 *
 * There is no browser API for macOS Focus, iOS Focus, or Windows Quiet Hours. This resolves
 * a quiet level from four evidence sources of decreasing fidelity and takes the strictest
 * result. Unknown evidence resolves quiet, never loud.
 *
 * Hysteresis matters more than it looks. A calendar event ending at 2:50 and a native Focus
 * mode ending at 2:52 will otherwise produce a two-second burst of audio between them, which
 * users experience as the app malfunctioning. Nothing un-mutes without dwelling.
 */

import { quietHoursWindow, type QuietHoursSettings } from "./quietHours";

export type QuietLevel =
  | "full"        // audio, speech, overlays all permitted
  | "visual_only" // no audio or speech; panel updates in place, no overlays
  | "silent";     // nothing surfaces; everything queues

export type QuietSource =
  | "manual" | "os_focus" | "quiet_hours" | "calendar_exam" | "calendar_busy"
  | "screen_share" | "fullscreen" | "mic_active" | "idle" | "default";

export interface QuietVerdict {
  level: QuietLevel;
  source: QuietSource;
  /** Shown verbatim in the header. Plain language, no jargon. */
  reason: string;
  /** When we expect to be able to speak again, if known. */
  until: Date | null;
  /** True when we're guessing because a higher-fidelity source was unavailable. */
  inferred: boolean;
}

const STRICTNESS: Record<QuietLevel, number> = { full: 0, visual_only: 1, silent: 2 };

/**
 * Tiebreak when two sources produce the same level. Exam outranks everything: several
 * downstream behaviours key off `source` and `activeEventCategory`, so a back-to-back
 * meeting and exam must not resolve to "you're in a meeting" and unlock exam content.
 */
const SOURCE_PRIORITY: Record<QuietSource, number> = {
  calendar_exam: 100, manual: 90, quiet_hours: 85, os_focus: 80, screen_share: 70,
  mic_active: 65, calendar_busy: 60, fullscreen: 50, idle: 40, default: 0,
};

const UNMUTE_DWELL_MS = 90_000;

/* ------------------------------------------------------------------ */
/* Evidence sources                                                    */
/* ------------------------------------------------------------------ */

/**
 * Native messaging host. Desktop Chrome and macOS Safari only — iOS has no equivalent, and
 * absence is expected rather than an error. See native-host/quiet-probe.py.
 */
export async function probeNativeFocus(): Promise<{ active: boolean; label?: string } | null> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendNativeMessage) return null;
  try {
    const res = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendNativeMessage(
        "com.acc.quietprobe",
        { q: "focus" },
        (r: { focus_active?: boolean; mode_name?: string } | undefined) =>
          chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r)
      );
    });
    return { active: Boolean(res?.focus_active), label: res?.mode_name };
  } catch {
    return null; // host not installed. Not a failure — just a missing source.
  }
}

export interface ActiveEvent {
  title: string;
  category: "exam" | "class" | "meeting" | "focus_block" | "other";
  start: Date;
  end: Date;
  busy: boolean;
}

/**
 * What the service worker feeds the resolver when the calendar backend is unreachable.
 *
 * Returning [] would leave the resolver with no calendar evidence. On a machine with a native
 * Focus host installed, probeNativeFocus() returns non-null, which suppresses the "no OS
 * access" fail-quiet default — so an empty list resolves to `full` and the assistant speaks
 * during a meeting it cannot see. A short synthetic busy block keeps it quiet instead. It
 * overlaps `now` by design and is recreated each tick, so quiet lifts on its own once
 * connectivity returns. See sw.ts getActiveEvents.
 */
export function offlineFallbackEvents(now: Date = new Date()): ActiveEvent[] {
  return [
    {
      title: "Calendar unavailable",
      category: "other",
      start: new Date(now.getTime() - 60_000),
      end: new Date(now.getTime() + 5 * 60_000),
      busy: true,
    },
  ];
}

/**
 * Page-level evidence, supplied by the service worker rather than probed here.
 *
 * An earlier version read `tab.sharingState`, which is not a stable Chrome API — it is not
 * in the extension surface and silently returns undefined, meaning screen sharing would
 * never have been detected. Screen share and mic state are only observable from a content
 * script that patches getDisplayMedia/getUserMedia on the page, so the signal is injected
 * and this module stays pure and testable.
 */
export interface PageSignals {
  screenSharing: boolean;
  micActive: boolean;
}

async function probeFullscreen(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.windows) return false;
  try {
    const w = await chrome.windows.getLastFocused();
    return w.state === "fullscreen";
  } catch {
    return false;
  }
}

async function probeIdle(): Promise<"active" | "idle" | "locked" | null> {
  if (typeof chrome === "undefined" || !chrome.idle) return null;
  try {
    return await chrome.idle.queryState(180);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Resolver                                                            */
/* ------------------------------------------------------------------ */

export class QuietModeEngine {
  private last: QuietVerdict | null = null;
  private lastChangeAt = 0;

  constructor(
    private readonly getActiveEvents: () => Promise<ActiveEvent[]>,
    private readonly getManualMute: () => Promise<{ muted: boolean; until: Date | null }>,
    private readonly getPageSignals: () => Promise<PageSignals> =
      async () => ({ screenSharing: false, micActive: false }),
    private readonly getQuietHours: () => Promise<QuietHoursSettings> =
      async () => ({ enabled: false, start: "22:00", end: "07:00" })
  ) {}

  async resolve(now = new Date()): Promise<QuietVerdict> {
    const candidates: QuietVerdict[] = [];

    const manual = await this.getManualMute();
    if (manual.muted) {
      candidates.push({
        level: "silent", source: "manual", until: manual.until, inferred: false,
        reason: manual.until ? `Muted until ${fmt(manual.until)}` : "Muted",
      });
    }

    const quietHours = quietHoursWindow(now, await this.getQuietHours());
    if (quietHours.active) {
      candidates.push({
        level: "silent", source: "quiet_hours", until: quietHours.until, inferred: false,
        reason: quietHours.until ? `Quiet hours until ${fmt(quietHours.until)}` : "Quiet hours",
      });
    }

    const native = await probeNativeFocus();
    if (native?.active) {
      candidates.push({
        level: "silent", source: "os_focus", until: null, inferred: false,
        reason: native.label ? `Quiet — ${native.label} is on` : "Quiet — Focus is on",
      });
    }

    const events = await this.getActiveEvents();
    for (const ev of events) {
      if (ev.end <= now || ev.start > now) continue;

      if (ev.category === "exam") {
        // Hardest case in the product. No audio, no overlay, no panel toast, nothing that
        // could read as assistance during an assessment.
        candidates.push({
          level: "silent", source: "calendar_exam", until: ev.end, inferred: false,
          reason: `Silent until ${fmt(ev.end)} — exam in progress`,
        });
      } else if (ev.busy) {
        candidates.push({
          level: "silent", source: "calendar_busy", until: ev.end, inferred: false,
          reason: `Quiet until ${fmt(ev.end)} — you're in ${describe(ev)}`,
        });
      }
    }

    const page = await this.getPageSignals();
    if (page.screenSharing) {
      candidates.push({
        level: "silent", source: "screen_share", until: null, inferred: true,
        reason: "Quiet — you're sharing your screen",
      });
    }
    if (page.micActive) {
      candidates.push({
        level: "silent", source: "mic_active", until: null, inferred: true,
        reason: "Quiet — your microphone is live",
      });
    }

    if (await probeFullscreen()) {
      candidates.push({
        level: "visual_only", source: "fullscreen", until: null, inferred: true,
        reason: "Sound off — you're in fullscreen",
      });
    }

    const idle = await probeIdle();
    if (idle === "locked") {
      candidates.push({
        level: "silent", source: "idle", until: null, inferred: true,
        reason: "Quiet — your screen is locked",
      });
    }

    // No native host on this platform and no positive signal? We are guessing, so we guess
    // conservatively. This is the single most important line in the file.
    if (native === null && candidates.length === 0) {
      candidates.push({
        level: "visual_only", source: "default", until: null, inferred: true,
        reason: "Sound off — can't read your Focus settings",
      });
    }

    const verdict = candidates.length
      ? candidates.reduce((a, b) => {
          if (STRICTNESS[b.level] !== STRICTNESS[a.level]) {
            return STRICTNESS[b.level] > STRICTNESS[a.level] ? b : a;
          }
          return SOURCE_PRIORITY[b.source] > SOURCE_PRIORITY[a.source] ? b : a;
        })
      : { level: "full" as const, source: "default" as const, until: null, inferred: false, reason: "" };

    return this.applyHysteresis(verdict, now);
  }

  /** Loosening waits; tightening is immediate. */
  private applyHysteresis(next: QuietVerdict, now: Date): QuietVerdict {
    const t = now.getTime();
    if (!this.last) { this.last = next; this.lastChangeAt = t; return next; }

    const loosening = STRICTNESS[next.level] < STRICTNESS[this.last.level];
    if (loosening && t - this.lastChangeAt < UNMUTE_DWELL_MS) return this.last;

    if (next.level !== this.last.level || next.source !== this.last.source) {
      this.lastChangeAt = t;
    }
    this.last = next;
    return next;
  }
}

/* ------------------------------------------------------------------ */
/* Alert routing                                                       */
/* ------------------------------------------------------------------ */

export interface Alert {
  id: string;
  text: string;
  scheduledFor: Date;
  /** Crisis alerts bypass every quiet rule. Nothing else may set this. */
  bypassQuiet?: true;
}

export interface AlertSinks {
  playChime: (a: Alert) => void;
  speak: (a: Alert) => void;
  showOverlay: (a: Alert) => void;
  updatePanel: (a: Alert) => void;
  enqueue: (a: Alert, heldReason: string) => void;
}

export function routeAlert(alert: Alert, verdict: QuietVerdict, sinks: AlertSinks): void {
  // A Focus setting is a preference about notifications. It is not a reason to withhold a
  // crisis resource from someone who just disclosed something. This branch has no else.
  if (alert.bypassQuiet) {
    sinks.updatePanel(alert);
    sinks.showOverlay(alert);
    return;
  }

  switch (verdict.level) {
    case "full":
      sinks.playChime(alert);
      sinks.speak(alert);
      sinks.showOverlay(alert);
      sinks.updatePanel(alert);
      return;
    case "visual_only":
      sinks.updatePanel(alert);
      return;
    case "silent":
      sinks.enqueue(alert, verdict.reason);
      return;
  }
}

/**
 * Flush on exit from silence. Batched into one summary rather than a burst of chimes —
 * five queued alerts firing at once when a class ends is its own kind of intrusion.
 */
export function flushQueue(queue: Alert[], sinks: AlertSinks): Alert | null {
  if (!queue.length) return null;
  const summary: Alert = {
    id: `flush-${Date.now()}`,
    text: queue.length === 1
      ? queue[0].text
      : `${queue.length} things came up while you were busy`,
    scheduledFor: new Date(),
  };
  sinks.playChime(summary);
  sinks.updatePanel(summary);
  queue.length = 0;
  return summary;
}

/* ------------------------------------------------------------------ */

function fmt(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function describe(ev: ActiveEvent): string {
  switch (ev.category) {
    case "class": return "class";
    case "meeting": return "a meeting";
    case "focus_block": return "focus time";
    default: return "an event";
  }
}
