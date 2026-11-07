/**
 * Provider capabilities — the single source of truth for what can be written where.
 *
 * This exists so the limitation surfaces at the moment it matters instead of living in a
 * README. Two enforcement points:
 *   1. Connect flow: the disclosure for a provider is generated from this table, and the
 *      database refuses to store a connection without an acknowledgement row.
 *   2. Write path: assertWritable() throws before any API call, with copy the panel shows
 *      verbatim. A user who asks to move a Canvas deadline gets told why it can't move,
 *      in the moment, rather than watching it silently fail.
 */

export type Provider =
  | "google" | "microsoft" | "canvas_api" | "canvas_ical" | "blackboard_ical";

export interface Capability {
  label: string;
  read: true;
  write: "full" | "partial" | "none";
  /** Shown in the connect disclosure, before the OAuth window opens. */
  disclosure: string;
  /** Shown when a write is attempted anyway. Plain language, no error codes. */
  writeRefusal?: string;
  scopes: string[];
}

export const CAPABILITIES: Record<Provider, Capability> = {
  google: {
    label: "Google Calendar",
    read: true,
    write: "full",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    disclosure:
      "Full access. Once you confirm a suggestion, it's created, moved, or deleted in your " +
      "real Google Calendar. Nothing is written without your confirmation first.",
  },
  microsoft: {
    label: "Microsoft 365",
    read: true,
    write: "full",
    scopes: ["Calendars.ReadWrite"],
    disclosure:
      "Full access. Once you confirm a suggestion, it's created, moved, or deleted in your " +
      "real Outlook calendar. If you're on a work account, your IT admin may need to " +
      "approve this first.",
  },
  canvas_api: {
    label: "Canvas (school-issued access)",
    read: true,
    write: "partial",
    scopes: ["url:GET|/api/v1/calendar_events", "url:POST|/api/v1/calendar_events"],
    disclosure:
      "Your school issued this access. Personal Canvas events can be added; assignment due " +
      "dates and course events are set by your instructors and can't be changed here.",
    writeRefusal:
      "Assignment due dates come from your instructor and can't be changed from here. I can " +
      "put a reminder or a work block on your own calendar instead.",
  },
  canvas_ical: {
    label: "Canvas calendar feed",
    read: true,
    write: "none",
    scopes: [],
    disclosure:
      "Read-only. A Canvas feed is a one-way export — I can see your assignments and " +
      "classes, but I can't add to it or change anything in it. Ever. Study blocks and " +
      "reminders go on your Google or Outlook calendar instead.",
    writeRefusal:
      "Your Canvas feed is read-only, so nothing can be changed there. Want me to put this " +
      "on your Google Calendar instead?",
  },
  blackboard_ical: {
    label: "Blackboard calendar feed",
    read: true,
    write: "none",
    scopes: [],
    disclosure:
      "Read-only. A Blackboard feed is a one-way export — I can see your coursework, but I " +
      "can't add to it or change anything in it. Reminders go on your Google or Outlook " +
      "calendar instead.",
    writeRefusal:
      "Your Blackboard feed is read-only, so nothing can be changed there. Want me to put " +
      "this on your Google Calendar instead?",
  },
};

/** Bump when disclosure text changes materially. Users re-acknowledge on the next connect. */
export const DISCLOSURE_VERSION = 1;

export const UNIVERSAL_DISCLOSURE = [
  "I read your calendars and suggest changes. You confirm every one before it happens.",
  "I can misread a date on a photo or a flyer. Check anything that matters.",
  "Course feeds from Canvas and Blackboard are read-only and can't be changed.",
] as const;

export class NotWritableError extends Error {
  readonly userMessage: string;
  constructor(readonly provider: Provider) {
    const cap = CAPABILITIES[provider];
    super(`${provider} is not writable (write=${cap.write})`);
    this.userMessage =
      cap.writeRefusal ?? `${cap.label} is read-only, so nothing can be changed there.`;
  }
}

/** Call before every provider write. Throws with copy the panel can render as-is. */
export function assertWritable(provider: Provider, intent: "create" | "update" | "delete"): void {
  const cap = CAPABILITIES[provider];
  if (cap.write === "none") throw new NotWritableError(provider);
  if (cap.write === "partial" && intent !== "create") throw new NotWritableError(provider);
}

export function isWritable(provider: Provider): boolean {
  return CAPABILITIES[provider].write !== "none";
}

/** Providers a confirmed event can actually be written to, for the "put it where?" picker. */
export function writableTargets(connected: Provider[]): Provider[] {
  return connected.filter(isWritable);
}
