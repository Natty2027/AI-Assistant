/**
 * Quiet hours — a user-set daily window (e.g. 10pm-7am) that resolves silent regardless of
 * calendar or OS Focus state. Pure and clock-driven, so it works identically with or without
 * a native Focus host installed.
 *
 * The only subtlety is the window crossing midnight, which is the common case (e.g. 22:00 ->
 * 07:00): "active" has to check two disjoint ranges, and "until" has to land on the right
 * calendar day depending on which side of midnight `now` falls on.
 */

export interface QuietHoursSettings {
  enabled: boolean;
  /** 24h local time, "HH:MM". */
  start: string;
  end: string;
}

export interface QuietHoursResult {
  active: boolean;
  /** When the window ends, if active. */
  until: Date | null;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function quietHoursWindow(now: Date, settings: QuietHoursSettings): QuietHoursResult {
  if (!settings.enabled) return { active: false, until: null };

  const startMin = toMinutes(settings.start);
  const endMin = toMinutes(settings.end);
  if (startMin === endMin) return { active: false, until: null }; // zero-length window: treat as off

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const wraps = startMin > endMin;

  const active = wraps
    ? nowMin >= startMin || nowMin < endMin
    : nowMin >= startMin && nowMin < endMin;

  if (!active) return { active: false, until: null };

  const until = new Date(now);
  until.setSeconds(0, 0);
  until.setHours(Math.floor(endMin / 60), endMin % 60);
  // Wrapping window, currently on the pre-midnight side: the end time lands tomorrow.
  if (wraps && nowMin >= startMin) until.setDate(until.getDate() + 1);

  return { active: true, until };
}
