/**
 * Talks to Google Calendar and Microsoft Graph: token refresh, creating one event, listing a
 * window of events. Nothing here touches the database or the HTTP layer, and `fetch` is
 * injected, so the whole module is tested against a fake provider.
 *
 * Tokens are decrypted only inside these functions, held in local variables, and never logged
 * or returned. Error messages carry a status code and a kind, never a response body, because a
 * provider's error body can echo request data.
 */
import { decryptToken, encryptToken } from "./crypto/envelope.ts";
import type { ProviderOAuthConfig } from "./config.ts";

export type CalProvider = "google" | "microsoft";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** unauthorized: reconnect needed. rejected: the provider refused this event. unavailable: retry later. */
export class ProviderError extends Error {
  constructor(readonly kind: "unauthorized" | "rejected" | "unavailable", message: string, readonly status?: number) {
    super(message);
  }
}

export interface StoredConn {
  id: string;
  provider: CalProvider;
  data_key_id: string;
  access_token_ct: Buffer;
  refresh_token_ct: Buffer | null;
  expires_at: Date | null;
}

export interface TokenStore {
  save(connId: string, access: Buffer, refresh: Buffer | null, expiresAt: Date): Promise<void>;
}

const REFRESH_MARGIN_MS = 60_000;
const TIMEOUT_MS = 15_000;

function classify(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("unauthorized", `provider refused access (${status})`, status);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return new ProviderError("rejected", `provider rejected the request (${status})`, status);
  }
  return new ProviderError("unavailable", `provider unavailable (${status})`, status);
}

async function call(f: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("unavailable", "could not reach the provider");
  }
}

/** A usable access token, refreshing and re-encrypting it first if it is (nearly) expired. */
export async function freshAccessToken(
  conn: StoredConn,
  cfg: ProviderOAuthConfig,
  store: TokenStore,
  f: FetchLike = fetch,
  now = Date.now()
): Promise<string> {
  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  if (expiresAt - now > REFRESH_MARGIN_MS) return decryptToken(conn.access_token_ct, conn.data_key_id);

  if (!conn.refresh_token_ct) throw new ProviderError("unauthorized", "sign-in expired and no refresh token is held");
  const res = await call(f, cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decryptToken(conn.refresh_token_ct, conn.data_key_id),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  // invalid_grant arrives as 400: the user revoked access or the token aged out.
  if (res.status === 400 || res.status === 401) throw new ProviderError("unauthorized", "refresh token no longer valid", res.status);
  if (!res.ok) throw classify(res.status);

  const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!t.access_token) throw new ProviderError("unavailable", "provider returned no access token");

  await store.save(
    conn.id,
    encryptToken(t.access_token, conn.data_key_id),
    // Microsoft rotates refresh tokens; Google usually does not. Keep the old one if none came back.
    t.refresh_token ? encryptToken(t.refresh_token, conn.data_key_id) : conn.refresh_token_ct,
    new Date(now + (t.expires_in ?? 3600) * 1000)
  );
  return t.access_token;
}

/* ------------------------------ creating an event ------------------------------ */

export interface NewEvent {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string | null;
  description: string | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Returns the provider's id for the created event. */
export async function createEvent(provider: CalProvider, token: string, ev: NewEvent, f: FetchLike = fetch): Promise<string> {
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let url: string;
  let body: unknown;

  if (provider === "google") {
    url = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    // All-day events use a date, and Google treats the end date as exclusive.
    const endDay = ev.end > ev.start ? day(ev.end) : day(new Date(ev.start.getTime() + 86_400_000));
    body = {
      summary: ev.title,
      location: ev.location ?? undefined,
      description: ev.description ?? undefined,
      start: ev.allDay ? { date: day(ev.start) } : { dateTime: ev.start.toISOString() },
      end: ev.allDay ? { date: endDay } : { dateTime: ev.end.toISOString() },
    };
  } else {
    url = "https://graph.microsoft.com/v1.0/me/events";
    // Graph wants a wall-clock string plus a zone name; UTC avoids any offset arithmetic here.
    const wall = (d: Date) => d.toISOString().replace("Z", "");
    const allDayEnd = ev.end > ev.start ? ev.end : new Date(ev.start.getTime() + 86_400_000);
    body = {
      subject: ev.title,
      body: { contentType: "text", content: ev.description ?? "" },
      isAllDay: ev.allDay,
      start: { dateTime: ev.allDay ? `${day(ev.start)}T00:00:00` : wall(ev.start), timeZone: "UTC" },
      end: { dateTime: ev.allDay ? `${day(allDayEnd)}T00:00:00` : wall(ev.end), timeZone: "UTC" },
      location: ev.location ? { displayName: ev.location } : undefined,
    };
  }

  const res = await call(f, url, { method: "POST", headers: auth, body: JSON.stringify(body) });
  if (!res.ok) throw classify(res.status);
  const created = (await res.json()) as { id?: string };
  if (!created.id) throw new ProviderError("unavailable", "provider created the event but returned no id");
  return created.id;
}

/* ------------------------------ listing a window ------------------------------ */

export interface CachedEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  busy: boolean;
  category: "exam" | "class" | "meeting" | "focus_block" | "other";
}

/** Labels only; they decide wording in the panel and whether exam lockout applies. A wrong
 *  guess toward "exam" makes the assistant quieter, which is the safe direction. */
export function categorize(title: string): CachedEvent["category"] {
  if (/\b(exam|midterm|final exam|finals week)\b/i.test(title)) return "exam";
  if (/\b(lecture|class|lab|seminar|recitation|section)\b/i.test(title)) return "class";
  if (/\b(meeting|stand-?up|sync|1:1|interview|call)\b/i.test(title)) return "meeting";
  if (/\bfocus\b/i.test(title)) return "focus_block";
  return "other";
}

export async function listEvents(provider: CalProvider, token: string, from: Date, to: Date, f: FetchLike = fetch): Promise<CachedEvent[]> {
  const auth = { Authorization: `Bearer ${token}` };

  if (provider === "google") {
    const q = new URLSearchParams({
      timeMin: from.toISOString(), timeMax: to.toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "250",
    });
    const res = await call(f, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: auth });
    if (!res.ok) throw classify(res.status);
    const items = ((await res.json()) as { items?: any[] }).items ?? [];
    return items.flatMap((e): CachedEvent[] => {
      if (e.status === "cancelled" || !e.id) return [];
      const allDay = Boolean(e.start?.date);
      const start = new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`);
      const end = new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00Z`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
      const title = String(e.summary ?? "Busy");
      const category = categorize(title);
      // An all-day entry (a birthday, a due date) does not make someone unavailable for the day,
      // unless it is an exam. Free-marked events never count as busy.
      const busy = e.transparency !== "transparent" && (!allDay || category === "exam");
      return [{ id: String(e.id), title, start, end, allDay, busy, category }];
    });
  }

  const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: "250" });
  const res = await call(f, `https://graph.microsoft.com/v1.0/me/calendarView?${q}`, {
    headers: { ...auth, Prefer: 'outlook.timezone="UTC"' },
  });
  if (!res.ok) throw classify(res.status);
  const items = ((await res.json()) as { value?: any[] }).value ?? [];
  return items.flatMap((e): CachedEvent[] => {
    if (e.isCancelled || !e.id) return [];
    // Graph returns UTC wall-clock text with no zone suffix when asked for UTC.
    const start = new Date(`${String(e.start?.dateTime).replace(/Z?$/, "Z")}`);
    const end = new Date(`${String(e.end?.dateTime).replace(/Z?$/, "Z")}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
    const allDay = Boolean(e.isAllDay);
    const title = String(e.subject ?? "Busy");
    const category = categorize(title);
    const busy = e.showAs !== "free" && (!allDay || category === "exam");
    return [{ id: String(e.id), title, start, end, allDay, busy, category }];
  });
}
