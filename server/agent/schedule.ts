/**
 * Schedule mode: Hera plans changes to the person's own calendar and reminders.
 *
 * The calendar never leaves the person's device except as a snapshot sent with one request: the
 * app reads the next few weeks of events and open reminders (EventKit) and sends them, and Hera
 * answers with proposed changes. The server cannot read or write any calendar. The app shows
 * each change and makes it only when the person approves it.
 *
 * Every change is checked here in code, whatever the model was persuaded of: it can only refer to
 * events and reminders that are in the snapshot, times must be real and in order, and calendars
 * must be ones the person can write to. Event titles and notes can come from other people (shared
 * invitations), so they are presented to the model as information, never as instructions.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

const MAX_EVENTS = 400;
const MAX_REMINDERS = 200;
const text = (max: number) => z.string().max(max);

/** A date and time with its offset, e.g. 2026-11-09T15:00:00-08:00. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** A calendar day, for all-day events: 2026-11-09. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dateTime = z.string().regex(DATE_TIME).refine((s) => !Number.isNaN(Date.parse(s)));

/** What the app sends: the person's schedule as their device sees it. Field names are snake_case,
 *  like every request body the app sends. */
export const ScheduleSnapshot = z.object({
  now: dateTime,
  time_zone: text(64).min(1),
  events: z.array(z.object({
    // Exchange and Outlook identifiers can be long.
    id: text(1000).min(1),
    title: text(300),
    start: dateTime,
    end: dateTime,
    all_day: z.boolean(),
    calendar: text(200),
    location: text(300).nullable().optional(),
  })).max(MAX_EVENTS),
  reminders: z.array(z.object({
    id: text(1000).min(1),
    title: text(300),
    due: dateTime.nullable().optional(),
    list: text(200),
  })).max(MAX_REMINDERS),
  calendars: z.array(z.object({ name: text(200).min(1), writable: z.boolean(), is_default: z.boolean().optional() })).max(100),
});
export type ScheduleSnapshot = z.infer<typeof ScheduleSnapshot>;

/** One change for the person to approve. Times use the same formats as the snapshot. */
export type ScheduleChange = { id: string; summary: string } & (
  | { kind: "add_event"; title: string; start: string; end: string; allDay: boolean; location: string | null; notes: string | null; calendar: string | null }
  | { kind: "change_event"; eventId: string; eventTitle: string; title: string | null; start: string | null; end: string | null; location: string | null }
  | { kind: "cancel_event"; eventId: string; eventTitle: string; start: string }
  | { kind: "add_reminder"; title: string; due: string | null; notes: string | null; list: string | null }
  | { kind: "complete_reminder"; reminderId: string; reminderTitle: string }
);

export const SCHEDULE_TOOL_NAMES = ["add_event", "change_event", "cancel_event", "add_reminder", "complete_reminder"] as const;

const obj = (properties: Record<string, unknown>) => ({
  type: "object" as const, properties, required: Object.keys(properties), additionalProperties: false,
});
const when = { type: "string", description: "Date and time with offset, e.g. 2026-11-09T15:00:00-08:00. For all-day events, a day: 2026-11-09." };
const summary = { type: "string", description: "One short sentence the person will see, e.g. \"Move the dentist to Friday at 3 PM\"" };

export const SCHEDULE_TOOLS = [
  { name: "add_event", description: "Propose adding an event to the person's calendar. Nothing changes until they approve it.", strict: true,
    input_schema: obj({
      title: { type: "string" }, start: when, end: { ...when, description: "When it ends. For all-day events, the last day (the same day for a one-day event)." },
      all_day: { type: "boolean" }, location: { type: ["string", "null"] }, notes: { type: ["string", "null"] },
      calendar: { type: ["string", "null"], description: "Name of one of their writable calendars, or null for their default" }, summary,
    }) },
  { name: "change_event", description: "Propose changing one existing event: give only what changes and null for the rest. Nothing changes until they approve it.", strict: true,
    input_schema: obj({
      event_id: { type: "string", description: "Id of an event from their schedule" },
      title: { type: ["string", "null"] }, start: { ...when, type: ["string", "null"] }, end: { ...when, type: ["string", "null"] },
      location: { type: ["string", "null"] }, summary,
    }) },
  { name: "cancel_event", description: "Propose deleting one existing event from their calendar. Nothing changes until they approve it.", strict: true,
    input_schema: obj({ event_id: { type: "string" }, summary }) },
  { name: "add_reminder", description: "Propose adding a reminder (a to-do), optionally with a due time. Nothing changes until they approve it.", strict: true,
    input_schema: obj({
      title: { type: "string" }, due: { type: ["string", "null"], description: "Date and time with offset, or null" },
      notes: { type: ["string", "null"] }, list: { type: ["string", "null"], description: "Name of one of their reminder lists, or null for the default" }, summary,
    }) },
  { name: "complete_reminder", description: "Propose marking one of their open reminders as done. Nothing changes until they approve it.", strict: true,
    input_schema: obj({ reminder_id: { type: "string" }, summary }) },
];

const nullableText = (max: number) => z.string().max(max).nullable();
export const SCHEDULE_INPUTS = {
  add_event: z.object({ title: z.string().min(1).max(300), start: z.string(), end: z.string(), all_day: z.boolean(),
    location: nullableText(300), notes: nullableText(2000), calendar: nullableText(200), summary: z.string().min(1).max(300) }).strict(),
  change_event: z.object({ event_id: z.string(), title: z.string().min(1).max(300).nullable(), start: z.string().nullable(), end: z.string().nullable(),
    location: nullableText(300), summary: z.string().min(1).max(300) }).strict(),
  cancel_event: z.object({ event_id: z.string(), summary: z.string().min(1).max(300) }).strict(),
  add_reminder: z.object({ title: z.string().min(1).max(300), due: z.string().nullable(), notes: nullableText(2000), list: nullableText(200),
    summary: z.string().min(1).max(300) }).strict(),
  complete_reminder: z.object({ reminder_id: z.string(), summary: z.string().min(1).max(300) }).strict(),
} as const;

export class ScheduleError extends Error {}

const MAX_SPAN_MS = 31 * 24 * 3_600_000;

function checkTimes(start: string, end: string, allDay: boolean): void {
  if (allDay) {
    if (!DAY.test(start) || !DAY.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
      throw new ScheduleError("All-day events use days like 2026-11-09 for start and end.");
    }
    if (end < start) throw new ScheduleError("The last day comes before the first day.");
    if (Date.parse(end) - Date.parse(start) > MAX_SPAN_MS) throw new ScheduleError("That's longer than a month; check the dates.");
    return;
  }
  if (!DATE_TIME.test(start) || !DATE_TIME.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
    throw new ScheduleError("Times need a date, time and offset, like 2026-11-09T15:00:00-08:00.");
  }
  if (Date.parse(end) <= Date.parse(start)) throw new ScheduleError("The end time must be after the start time.");
  if (Date.parse(end) - Date.parse(start) > MAX_SPAN_MS) throw new ScheduleError("That's longer than a month; check the times.");
}

const newId = () => `s_${randomBytes(6).toString("hex")}`;

/** Turns one validated tool call into a change, or explains what's wrong with it. */
export function scheduleChange(tool: (typeof SCHEDULE_TOOL_NAMES)[number], input: any, snapshot: ScheduleSnapshot): ScheduleChange {
  const event = (id: string) => {
    const e = snapshot.events.find((x) => x.id === id);
    if (!e) throw new ScheduleError("That isn't one of the events in their schedule. Use an id from the list.");
    return e;
  };
  const writable = (name: string | null) => {
    if (name !== null && !snapshot.calendars.some((c) => c.name === name && c.writable)) {
      throw new ScheduleError("That isn't one of their calendars they can change. Use a name from the list, or null.");
    }
    return name;
  };

  switch (tool) {
    case "add_event":
      checkTimes(input.start, input.end, input.all_day);
      return { id: newId(), summary: input.summary, kind: "add_event", title: input.title, start: input.start, end: input.end,
        allDay: input.all_day, location: input.location, notes: input.notes, calendar: writable(input.calendar) };
    case "change_event": {
      const e = event(input.event_id);
      if (input.title === null && input.start === null && input.end === null && input.location === null) {
        throw new ScheduleError("Nothing would change. Give the new title, time or place.");
      }
      if (!snapshot.calendars.some((c) => c.name === e.calendar && c.writable)) {
        throw new ScheduleError("That event is on a calendar they can't change (for example, one shared with them).");
      }
      const isDay = (v: string | null) => v !== null && DAY.test(v);
      if (isDay(input.start) || isDay(input.end)) {
        if (!e.all_day) throw new ScheduleError("Only all-day events take days. Give a date, time and offset.");
        const start = input.start ?? e.start.slice(0, 10);
        checkTimes(start, input.end ?? start, true);
      } else if (input.start !== null || input.end !== null) {
        // Moving only the start keeps the length; the app does the same arithmetic.
        const start = input.start ?? e.start;
        const end = input.end ?? new Date(Date.parse(start) + (Date.parse(e.end) - Date.parse(e.start))).toISOString();
        checkTimes(start, end, false);
      }
      return { id: newId(), summary: input.summary, kind: "change_event", eventId: e.id, eventTitle: e.title,
        title: input.title, start: input.start, end: input.end, location: input.location };
    }
    case "cancel_event": {
      const e = event(input.event_id);
      if (!snapshot.calendars.some((c) => c.name === e.calendar && c.writable)) {
        throw new ScheduleError("That event is on a calendar they can't change (for example, one shared with them).");
      }
      return { id: newId(), summary: input.summary, kind: "cancel_event", eventId: e.id, eventTitle: e.title, start: e.start };
    }
    case "add_reminder":
      if (input.due !== null && (!DATE_TIME.test(input.due) || Number.isNaN(Date.parse(input.due)))) {
        throw new ScheduleError("A due time needs a date, time and offset, like 2026-11-09T09:00:00-08:00, or null.");
      }
      return { id: newId(), summary: input.summary, kind: "add_reminder", title: input.title, due: input.due, notes: input.notes, list: input.list };
    case "complete_reminder": {
      const r = snapshot.reminders.find((x) => x.id === input.reminder_id);
      if (!r) throw new ScheduleError("That isn't one of their open reminders. Use an id from the list.");
      return { id: newId(), summary: input.summary, kind: "complete_reminder", reminderId: r.id, reminderTitle: r.title };
    }
  }
}

/** The schedule as the model sees it. Ids are opaque; titles are quoted data, not instructions. */
export function describeSchedule(s: ScheduleSnapshot): string {
  const events = s.events.length
    ? s.events.map((e) => `- ${e.id}: ${JSON.stringify(e.title)} ${e.all_day ? `all day ${e.start.slice(0, 10)} to ${e.end.slice(0, 10)}` : `${e.start} to ${e.end}`}`
      + ` [${JSON.stringify(e.calendar)}]${e.location ? ` at ${JSON.stringify(e.location)}` : ""}`).join("\n")
    : "- (no events in this period)";
  const reminders = s.reminders.length
    ? s.reminders.map((r) => `- ${r.id}: ${JSON.stringify(r.title)}${r.due ? ` due ${r.due}` : ""} [${JSON.stringify(r.list)}]`).join("\n")
    : "- (no open reminders)";
  const calendars = s.calendars.map((c) => `- ${JSON.stringify(c.name)}${c.writable ? "" : " (read only)"}${c.is_default ? " (default)" : ""}`).join("\n") || "- (none)";
  return `It is now ${s.now} in time zone ${s.time_zone}. Write every time with this zone's offset.

Their calendars:
${calendars}

Their events (id: title, when, [calendar]):
${events}

Their open reminders (id: title, due, [list]):
${reminders}`;
}
