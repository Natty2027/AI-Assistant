/**
 * Turning a proposal the user approved into a real calendar event.
 *
 * The rule the whole product rests on: nothing reaches a provider without an explicit tap, and
 * a tap writes exactly once. So confirming first CLAIMS the proposal (pending -> confirmed) in a
 * single conditional update, and only the request that wins the claim talks to the provider. A
 * double click, a retry, or two open panels therefore cannot create two events. If the provider
 * refuses, the claim is released so the user can fix the problem and try again.
 *
 * The database independently enforces the other half: written_event_id can only be set on a
 * row that is already confirmed (CHECK no_write_without_confirmation).
 */
import {
  createEvent, freshAccessToken, ProviderError,
  type CalProvider, type FetchLike,
} from "./calendar.ts";
import { loadConnections, markRevoked, tokenStore, type Run } from "./connections.ts";
import type { ProviderOAuthConfig } from "./config.ts";
import { HttpError } from "./http.ts";

export interface Deps {
  run: Run;
  fetch: FetchLike;
  cfg: Partial<Record<CalProvider, ProviderOAuthConfig | undefined>>;
}

export interface ConfirmInput {
  provider?: unknown;
  title?: unknown;
  start?: unknown;
  end?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(id: string): void {
  if (!UUID.test(id)) throw new HttpError(400, "That isn't a valid id.");
}

function asDate(v: unknown): Date | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function listPending(run: Run, userId: string) {
  const { rows } = await run(
    `select id, title, start_time, end_time, all_day, location, needs_review, assumptions, source, created_at
       from proposed_events
      where user_id = $1 and status = 'pending_confirmation'
      order by created_at desc limit 50`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    start: r.start_time ? new Date(r.start_time).toISOString() : null,
    end: r.end_time ? new Date(r.end_time).toISOString() : null,
    all_day: Boolean(r.all_day),
    location: (r.location as string | null) ?? null,
    needs_review: r.needs_review as string[],
    assumptions: r.assumptions as string[],
    source: r.source as string,
  }));
}

export async function rejectProposal(run: Run, userId: string, id: string): Promise<void> {
  assertUuid(id);
  const { rows } = await run(
    `update proposed_events set status = 'rejected'
      where id = $1 and user_id = $2 and status = 'pending_confirmation' returning id`,
    [id, userId]
  );
  if (!rows.length) throw new HttpError(404, "That suggestion is no longer waiting for a decision.");
}

export async function confirmProposal(
  deps: Deps, userId: string, id: string, input: ConfirmInput
): Promise<{ eventId: string; provider: CalProvider }> {
  assertUuid(id);
  const { run } = deps;

  const found = await run(`select * from proposed_events where id = $1 and user_id = $2`, [id, userId]);
  const p = found.rows[0];
  if (!p) throw new HttpError(404, "I can't find that suggestion.");
  if (p.status !== "pending_confirmation") throw new HttpError(409, "That suggestion has already been handled.");

  // What the user saw and approved may include their own corrections.
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 300) : String(p.title);
  const start = input.start !== undefined ? asDate(input.start) : asDate(p.start_time);
  const allDay = Boolean(p.all_day);
  let end = input.end !== undefined ? asDate(input.end) : asDate(p.end_time);

  if (!start) throw new HttpError(400, "This needs a start time before it can be added.", true, "needs_start_time");
  if (!allDay) {
    // The extractor never guesses a duration, so neither does this: a timed event without an
    // end is the user's call, not ours.
    if (!end) throw new HttpError(400, "This needs an end time before it can be added.", true, "needs_end_time");
    if (end <= start) throw new HttpError(400, "The end time has to be after the start time.", true, "bad_range");
  } else if (!end || end <= start) {
    end = new Date(start.getTime() + 86_400_000);
  }

  const wanted = typeof input.provider === "string" ? (input.provider as CalProvider) : undefined;
  const conns = await loadConnections(run, userId, wanted);
  if (conns.length === 0) {
    throw new HttpError(409, "Connect Google Calendar or Outlook first, then add this.", true, "no_calendar");
  }
  if (conns.length > 1 && !wanted) {
    throw new HttpError(409, "Choose which calendar to add this to.", true, "choose_calendar");
  }
  const conn = conns[0];
  const cfg = deps.cfg[conn.provider];
  if (!cfg) throw new HttpError(503, `${conn.provider} isn't configured on this server.`);

  // Claim. Exactly one concurrent request gets a row back; the rest stop here.
  const claim = await run(
    `update proposed_events set status = 'confirmed', confirmed_at = now()
      where id = $1 and user_id = $2 and status = 'pending_confirmation' returning id`,
    [id, userId]
  );
  if (!claim.rows.length) throw new HttpError(409, "That suggestion has already been handled.");

  let eventId: string;
  try {
    const token = await freshAccessToken(conn, cfg, tokenStore(run), deps.fetch);
    eventId = await createEvent(
      conn.provider, token,
      { title, start, end: end!, allDay, location: p.location ?? null, description: p.description ?? null },
      deps.fetch
    );
  } catch (e) {
    // Release the claim so the user can retry; nothing was written.
    await run(
      `update proposed_events set status = 'pending_confirmation', confirmed_at = null
        where id = $1 and user_id = $2 and status = 'confirmed' and written_event_id is null`,
      [id, userId]
    );
    if (e instanceof ProviderError) {
      if (e.kind === "unauthorized") {
        await markRevoked(run, conn.id);
        throw new HttpError(409, "Your calendar sign-in has expired. Reconnect it in Settings, then try again.", true, "reconnect_needed");
      }
      if (e.kind === "rejected") throw new HttpError(422, "Your calendar didn't accept that event. Check the details and try again.");
      throw new HttpError(502, "Couldn't reach your calendar. Nothing was added; try again in a moment.");
    }
    throw e;
  }

  // The event now exists. Record it, along with any corrections the user made. If this write
  // fails the row stays 'confirmed', so a retry is refused rather than creating a duplicate.
  await run(
    `update proposed_events
        set written_event_id = $3, title = $4, start_time = $5, end_time = $6
      where id = $1 and user_id = $2`,
    [id, userId, eventId, title, start.toISOString(), end!.toISOString()]
  );
  return { eventId, provider: conn.provider };
}
