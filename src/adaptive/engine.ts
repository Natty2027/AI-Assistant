/**
 * DELIVERABLE 3 (part 2) — adaptive learning, gated.
 *
 * Every public function begins by reading the toggle from the database, not from a cached
 * value, not from a request parameter, and not from the session. The database triggers in
 * schema.sql are the backstop; these checks are the fast path that produces a clean error
 * instead of an exception.
 *
 * What is learned: structural timing patterns per category and weekday.
 * What is never learned: event titles, attendees, locations, notes, message text, anything
 * from a turn that tripped the safety layer.
 */

import type { Pool } from "pg";

export type AutomationState = "on" | "off" | "forbidden_by_policy";

export interface HabitProposal {
  category: string;
  dayOfWeek: number;
  suggestedStartMinute: number;
  suggestedDurationMinutes: number | null;
  confidence: number;
  sampleSize: number;
  rationale: string;
}

const MIN_SAMPLES = 6;          // below this, a "pattern" is noise
const MIN_CONFIDENCE = 0.7;
const OBSERVATION_TTL_DAYS = 180;

/* ------------------------------------------------------------------ */
/* Gate                                                               */
/* ------------------------------------------------------------------ */

export async function getAutomationState(db: Pool, userId: string): Promise<AutomationState> {
  const { rows } = await db.query(
    `select s.adaptive_automation_enabled as enabled,
            coalesce(o.policy_forbid_adaptive, false) as forbidden
       from user_settings s
       left join organizations o on o.id = s.org_id
      where s.user_id = $1`,
    [userId]
  );
  if (!rows.length) return "off";
  if (rows[0].forbidden) return "forbidden_by_policy";
  return rows[0].enabled ? "on" : "off";
}

export class AutomationDisabledError extends Error {
  constructor(readonly state: AutomationState) {
    super(
      state === "forbidden_by_policy"
        ? "Adaptive automation is disabled by your organization's policy."
        : "Adaptive Automation is OFF. Turn it on in Settings to use this."
    );
  }
}

/* ------------------------------------------------------------------ */
/* Toggle                                                             */
/* ------------------------------------------------------------------ */

/**
 * Flipping to OFF fires the purge trigger. This function reports what was destroyed so the
 * UI can confirm it honestly ("Deleted 214 observations and 9 learned patterns") rather than
 * showing a vague "turned off".
 */
export async function setAutomation(
  db: Pool,
  userId: string,
  enabled: boolean
): Promise<{ state: AutomationState; purged: { observations: number; profiles: number } }> {
  const state = await getAutomationState(db, userId);
  if (state === "forbidden_by_policy") throw new AutomationDisabledError(state);

  const client = await db.connect();
  try {
    await client.query("begin");

    const before = enabled
      ? { observations: 0, profiles: 0 }
      : (
          await client.query(
            `select (select count(*) from habit_observations where user_id=$1)::int as observations,
                    (select count(*) from habit_profiles     where user_id=$1)::int as profiles`,
            [userId]
          )
        ).rows[0];

    await client.query(
      `update user_settings set adaptive_automation_enabled = $2 where user_id = $1`,
      [userId, enabled]
    );

    await client.query(
      `insert into audit_log (user_id, action, target_type, metadata)
       select $1, $2, 'user_settings', $3
        where exists (select 1 from user_settings where user_id=$1 and tier='enterprise')`,
      [userId, enabled ? "adaptive_automation.enabled" : "adaptive_automation.disabled",
       JSON.stringify(before)]
    );

    await client.query("commit");
    return { state: enabled ? "on" : "off", purged: before };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Observation capture                                                */
/* ------------------------------------------------------------------ */

/**
 * Called when a user creates, moves, or declines an event. Silently no-ops when the toggle
 * is off — this is the one place a silent return is correct, because the caller is a UI
 * side-effect and should not surface an error for a feature the user switched off.
 */
export async function recordObservation(
  db: Pool,
  userId: string,
  obs: {
    category: string;
    dayOfWeek: number;
    originalStartMinute: number | null;
    finalStartMinute: number;
    durationMinutes: number | null;
    action: "created" | "moved" | "deleted" | "accepted" | "declined";
    fromSafetyFlaggedTurn?: boolean;
  }
): Promise<void> {
  if (obs.fromSafetyFlaggedTurn) return;              // never learn from an intercepted turn
  if ((await getAutomationState(db, userId)) !== "on") return;

  await db.query(
    `insert into habit_observations
       (user_id, category, day_of_week, original_start_minute, final_start_minute,
        duration_minutes, action)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, obs.category, obs.dayOfWeek, obs.originalStartMinute, obs.finalStartMinute,
     obs.durationMinutes, obs.action]
  );
}

/* ------------------------------------------------------------------ */
/* Inference                                                          */
/* ------------------------------------------------------------------ */

export async function rebuildHabitProfile(db: Pool, userId: string): Promise<number> {
  const state = await getAutomationState(db, userId);
  if (state !== "on") throw new AutomationDisabledError(state);

  await db.query(
    `delete from habit_observations
      where user_id = $1 and observed_at < now() - ($2 || ' days')::interval`,
    [userId, OBSERVATION_TTL_DAYS]
  );

  // Median rather than mean: one 3am cram session should not drag the whole pattern.
  // Confidence rises with sample size and falls with dispersion.
  const { rowCount } = await db.query(
    `insert into habit_profiles
       (user_id, category, day_of_week, median_start_minute, median_duration_minutes,
        sample_size, confidence)
     select
       user_id,
       category,
       day_of_week,
       percentile_cont(0.5) within group (order by final_start_minute)::int,
       percentile_cont(0.5) within group (order by duration_minutes)::int,
       count(*)::int,
       least(
         0.99,
         (count(*)::real / ($2 * 2))
         * (1.0 - least(1.0, coalesce(stddev_samp(final_start_minute), 0) / 120.0))
       )
     from habit_observations
     where user_id = $1
       and action in ('created','moved','accepted')
     group by user_id, category, day_of_week
     having count(*) >= $2
     on conflict (user_id, category, day_of_week) do update set
       median_start_minute     = excluded.median_start_minute,
       median_duration_minutes = excluded.median_duration_minutes,
       sample_size             = excluded.sample_size,
       confidence              = excluded.confidence,
       updated_at              = now()`,
    [userId, MIN_SAMPLES]
  );

  return rowCount ?? 0;
}

export async function generateProposals(db: Pool, userId: string): Promise<HabitProposal[]> {
  const state = await getAutomationState(db, userId);
  if (state !== "on") throw new AutomationDisabledError(state);

  const { rows } = await db.query(
    `select category, day_of_week, median_start_minute, median_duration_minutes,
            sample_size, confidence
       from habit_profiles
      where user_id = $1 and confidence >= $2
      order by confidence desc`,
    [userId, MIN_CONFIDENCE]
  );

  return rows.map((r) => ({
    category: r.category,
    dayOfWeek: r.day_of_week,
    suggestedStartMinute: r.median_start_minute,
    suggestedDurationMinutes: r.median_duration_minutes,
    confidence: r.confidence,
    sampleSize: r.sample_size,
    // The rationale is shown verbatim in the UI. A user should always be able to see why the
    // app thinks it knows something about them.
    rationale:
      `You've scheduled ${r.category} around ${fmt(r.median_start_minute)} on ` +
      `${DAYS[r.day_of_week]}s ${r.sample_size} times in the last ${OBSERVATION_TTL_DAYS} days.`,
  }));
}

/**
 * Proposals become pending_confirmation rows. They do not become calendar events.
 * The CHECK constraint in schema.sql enforces this even if this function is wrong.
 */
export async function stageProposals(
  db: Pool,
  userId: string,
  proposals: HabitProposal[],
  weekOf: Date,
  timeZone: string
): Promise<number> {
  if ((await getAutomationState(db, userId)) !== "on") return 0;

  let staged = 0;
  for (const p of proposals) {
    const start = dateForWeekday(weekOf, p.dayOfWeek, p.suggestedStartMinute, timeZone);
    const conflict = await hasConflict(db, userId, start, p.suggestedDurationMinutes ?? 60);
    if (conflict) continue;

    await db.query(
      `insert into proposed_events
         (user_id, source, title, start_time, end_time, all_day, confidence, assumptions,
          needs_review, status)
       values ($1,'habit_engine',$2,$3,$4,false,$5,$6,'["start_time"]','pending_confirmation')`,
      [
        userId,
        `${p.category} (suggested)`,
        start.toISOString(),
        new Date(start.getTime() + (p.suggestedDurationMinutes ?? 60) * 60_000).toISOString(),
        JSON.stringify({ start_time: p.confidence }),
        JSON.stringify([p.rationale]),
      ]
    );
    staged++;
  }
  return staged;
}

/* ------------------------------------------------------------------ */
/* Cross-calendar conflict check                                      */
/* ------------------------------------------------------------------ */

async function hasConflict(
  db: Pool, userId: string, start: Date, durationMinutes: number
): Promise<boolean> {
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const { rows } = await db.query(
    `select 1 from events_cache
      where user_id = $1
        and tstzrange(start_time, end_time, '[)') && tstzrange($2, $3, '[)')
      limit 1`,
    [userId, start.toISOString(), end.toISOString()]
  );
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmt(minute: number): string {
  const h = Math.floor(minute / 60), m = minute % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * Resolves a weekday + minute-of-day into an instant.
 *
 * setHours/getDay run in the *server's* timezone. On a UTC container proposing a 7:00 PM
 * dinner for a user in Los Angeles, that lands at noon. Observations are recorded as
 * minute-of-day in the user's local time, so the proposal has to be rebuilt there too.
 */
function dateForWeekday(
  weekOf: Date, dayOfWeek: number, minute: number, timeZone: string
): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(weekOf);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const localDow = WD.indexOf(get("weekday"));

  const base = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + ((dayOfWeek - localDow + 7) % 7));

  const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, d = base.getUTCDate();
  const h = Math.floor(minute / 60), mi = minute % 60;
  const naive = `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:00`;

  // Resolve the wall-clock time to an instant by measuring the zone's offset on that date.
  const probe = new Date(`${naive}Z`);
  const offsetMs = probe.getTime() - new Date(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(probe).replace(" ", "T") + "Z"
  ).getTime();

  return new Date(probe.getTime() + offsetMs);
}

const pad = (n: number) => String(n).padStart(2, "0");
