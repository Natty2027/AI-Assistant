/**
 * <input type="datetime-local"> speaks "YYYY-MM-DDTHH:mm" in the user's LOCAL time, with no
 * zone. The server wants an absolute instant. Getting this wrong shifts an event by the user's
 * UTC offset, which is how someone ends up at a 7pm dinner at noon, so the two conversions
 * live here, tested, rather than inline in the panel.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO instant -> the value a datetime-local input should show, in local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What the user typed (local wall-clock) -> an absolute ISO instant, or null if it is blank or malformed. */
export function fromLocalInput(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  // No zone suffix means the Date constructor reads this as local time, which is what was typed.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
