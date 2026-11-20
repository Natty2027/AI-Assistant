/**
 * Calendar invites as .ics files (RFC 5545), the format Gmail, Outlook, Apple Calendar and every
 * other calendar understand. Used two ways: attached to an email Hera writes, so guests tap "Add to
 * calendar", and as a file on the person's website behind an "Add to my calendar" link.
 *
 * METHOD:PUBLISH ("here's an event") rather than REQUEST ("please RSVP"): it adds cleanly everywhere
 * without an organizer mailbox to receive replies. Times are written in UTC, so they're right in
 * every time zone.
 */
import { createHash } from "node:crypto";

export interface CalendarEvent {
  title: string;
  /** ISO 8601 with an offset, e.g. 2026-11-21T10:00:00-08:00. */
  start: string;
  end: string;
  location: string | null;
  description: string | null;
  url?: string | null;
}

export class IcsError extends Error {}

/** 2026-11-21T18:00:00Z as 20261121T180000Z. */
function utc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) throw new IcsError(`"${iso}" needs a date, a time and a time-zone offset.`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Text values escape backslash, semicolon, comma and line breaks. */
function text(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets are folded: a line break, then a space. */
function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > (out.length ? 74 : 75)) { out.push(current); current = ""; }
    current += ch;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** One event as a complete .ics file. The id is stable for the same event, so adding it twice updates it. */
export function makeIcs(e: CalendarEvent, now = new Date()): string {
  const start = utc(e.start);
  const end = utc(e.end);
  if (end <= start) throw new IcsError("The event has to end after it starts.");
  const uid = createHash("sha256").update(`${e.title}|${start}`).digest("hex").slice(0, 24) + "@hera";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hera//Hera//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utc(now.toISOString())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${text(e.title)}`,
    ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${text(e.description)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
