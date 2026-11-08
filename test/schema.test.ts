/**
 * Loads db/schema.sql into an in-process Postgres (PGlite) and asserts the security properties
 * the schema claims. Until this existed the schema had never been executed, and the first run
 * found it could not even load.
 *
 * Supabase provides a few things the schema depends on; they are stubbed below. This is a
 * faithful stand-in for the parts under test (roles, column grants, RLS, triggers, CHECKs), but
 * it is not Supabase: run the schema there too before shipping.
 *
 * Tests share one database and run in order, because several build on earlier state (a toggle
 * switched on, then purged). Each check that must observe a *denied* escalation uses its own
 * user, so a regression that lets one through cannot silently change what a later check sees.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const A = "00000000-0000-0000-0000-00000000000a"; // member of org X, used for the toggle/purge flow
const B = "00000000-0000-0000-0000-00000000000b"; // admin of org X
const C = "00000000-0000-0000-0000-00000000000c"; // member of org F, which forbids adaptive
const D = "00000000-0000-0000-0000-00000000000d"; // personal user, no org
const E = "00000000-0000-0000-0000-00000000000e"; // enterprise member of X, only for the audit check
const X = "10000000-0000-0000-0000-000000000001";
const F = "10000000-0000-0000-0000-000000000002";

const db = new PGlite({ extensions: { btree_gist } });

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}

/** Runs a statement and returns the error message, or null if it succeeded. */
async function failure(sql: string, uid?: string): Promise<string | null> {
  const run = async () => { try { await db.query(sql); return null; } catch (e) { return (e as Error).message; } };
  return uid ? asUser(uid, run) : run();
}

async function mustFail(sql: string, re: RegExp, uid?: string): Promise<void> {
  const msg = await failure(sql, uid);
  assert.notEqual(msg, null, `expected this to fail but it succeeded: ${sql}`);
  assert.match(msg!, re);
}

async function mustSucceed(sql: string, uid?: string): Promise<void> {
  const msg = await failure(sql, uid);
  assert.equal(msg, null, `expected success but got: ${msg}`);
}

async function count(sql: string, uid?: string): Promise<number> {
  const run = async () => ((await db.query<{ n: number }>(sql)).rows[0].n);
  return uid ? asUser(uid, run) : run();
}

before(async () => {
  // What Supabase provides: the auth schema, auth.uid(), and the two client roles, with the
  // default grants that make the schema's revokes and column grants meaningful.
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);

  // The schema creates btree_gist itself, so only the extensions PGlite lacks are removed.
  const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8")
    .replace(/create extension if not exists "pgcrypto";/i, "")
    .replace(/create extension if not exists "supabase_vault";[^\n]*/i, "");
  await db.exec(sql);

  await db.exec(`
    insert into auth.users (id) values ('${A}'),('${B}'),('${C}'),('${D}'),('${E}');
    insert into organizations (id, name, tier, policy_forbid_adaptive)
      values ('${X}','Org X','enterprise',false), ('${F}','Org F','enterprise',true);
    insert into user_settings (user_id, org_id, org_role, tier) values
      ('${A}','${X}','member','enterprise'),
      ('${B}','${X}','admin','enterprise'),
      ('${E}','${X}','member','enterprise'),
      ('${C}','${F}','member','enterprise');
    insert into user_settings (user_id) values ('${D}');
    insert into audit_log (org_id, action) values ('${X}','test.action');
  `);
});

/* ---- users cannot rewrite the columns that carry privilege ---- */

test("a member cannot null org_id to escape an org policy", () =>
  mustFail(`update user_settings set org_id = null where user_id = '${A}'`, /permission denied/i, A));
test("a member cannot change their tier", () =>
  mustFail(`update user_settings set tier = 'personal' where user_id = '${A}'`, /permission denied/i, A));
test("a member cannot promote themselves to org admin", () =>
  mustFail(`update user_settings set org_role = 'admin' where user_id = '${A}'`, /permission denied/i, A));
test("a personal user cannot join an org", () =>
  mustFail(`update user_settings set org_id = '${X}' where user_id = '${D}'`, /permission denied/i, D));
test("a personal user cannot claim the enterprise tier", () =>
  mustFail(`update user_settings set tier = 'enterprise' where user_id = '${D}'`, /permission denied/i, D));
test("a user cannot write their own AI consent flag", () =>
  mustFail(`update user_settings set ai_consent_at = now() where user_id = '${D}'`, /permission denied/i, D));
test("a user cannot delete their settings row", () =>
  mustFail(`delete from user_settings where user_id = '${D}'`, /permission denied/i, D));
test("a user cannot insert a settings row with org_id preset", () =>
  mustFail(`insert into user_settings (user_id, org_id) values ('${D}', '${X}') on conflict do nothing`, /permission denied/i, D));
test("auto_commit_enabled stays pinned off", () =>
  mustFail(`update user_settings set auto_commit_enabled = true where user_id = '${D}'`, /auto_commit_always_off|check/i));

/* ---- the audit log is admin-only ---- */

test("an org member who is not an admin sees no audit rows", async () =>
  assert.equal(await count(`select count(*)::int n from audit_log`, E), 0));
test("an org admin sees their org's audit rows", async () =>
  assert.equal(await count(`select count(*)::int n from audit_log`, B), 1));
test("a personal user sees no audit rows", async () =>
  assert.equal(await count(`select count(*)::int n from audit_log`, D), 0));

/* ---- adaptive toggle: org policy, storage-layer gate, purge ---- */

test("an org that forbids adaptive automation blocks the toggle being switched on", () =>
  mustFail(`update user_settings set adaptive_automation_enabled = true where user_id = '${C}'`, /organization policy/i, C));

test("a member of a permitting org can switch the toggle on", () =>
  mustSucceed(`update user_settings set adaptive_automation_enabled = true where user_id = '${A}'`, A));

test("with the toggle on, observations, profiles and a habit proposal can be written", async () => {
  await mustSucceed(`insert into habit_observations (user_id, category, day_of_week, final_start_minute, action)
                     values ('${A}','class',2,600,'created')`);
  await mustSucceed(`insert into habit_profiles (user_id, category, day_of_week, median_start_minute, sample_size, confidence)
                     values ('${A}','class',2,600,6,0.8)`);
  await mustSucceed(`insert into proposed_events (user_id, source, title) values ('${A}','habit_engine','Class (suggested)')`);
});

test("turning the toggle off destroys observations, profiles and pending habit proposals", async () => {
  await mustSucceed(`update user_settings set adaptive_automation_enabled = false where user_id = '${A}'`, A);
  assert.equal(await count(`select count(*)::int n from habit_observations where user_id='${A}'`), 0);
  assert.equal(await count(`select count(*)::int n from habit_profiles where user_id='${A}'`), 0);
  assert.equal(await count(`select count(*)::int n from proposed_events where user_id='${A}' and source='habit_engine'`), 0);
});

test("with the toggle off, the database itself rejects new observations", () =>
  mustFail(`insert into habit_observations (user_id, category, day_of_week, final_start_minute, action)
            values ('${A}','class',2,600,'created')`, /adaptive automation is OFF/i));

/* ---- nothing is written to a provider without confirmation ---- */

test("a provider event id requires a confirmed proposal", () =>
  mustFail(`insert into proposed_events (user_id, source, title, written_event_id) values ('${D}','chat','X','evt-1')`,
    /no_write_without_confirmation|check/i));
test("a confirmed proposal may carry a provider event id", () =>
  mustSucceed(`insert into proposed_events (user_id, source, title, status, confirmed_at, written_event_id)
               values ('${D}','chat','Y','confirmed', now(), 'evt-2')`));

/* ---- connecting requires a current disclosure acknowledgement ---- */

const connect = (uid: string, provider = "google") =>
  `insert into oauth_connections (user_id, provider, account_email, access_token_ct, data_key_id)
   values ('${uid}','${provider}','a@b.c','\\x00','k')`;

test("a connection is refused when no disclosure is on file", () =>
  mustFail(connect(D), /no current disclosure/i));
test("a user can acknowledge a disclosure for themselves", () =>
  mustSucceed(`insert into connection_disclosures (user_id, provider, disclosure_version) values ('${D}','google',1)`, D));
test("a user cannot acknowledge a disclosure on someone else's behalf", () =>
  mustFail(`insert into connection_disclosures (user_id, provider, disclosure_version) values ('${A}','google',1)`,
    /row-level security/i, D));
test("a connection succeeds once the provider is disclosed", () => mustSucceed(connect(D)));
test("a disclosure for one provider does not cover another", () =>
  mustFail(connect(D, "microsoft"), /no current disclosure/i));
test("the client role cannot read OAuth tokens at all", () =>
  mustFail(`select * from oauth_connections`, /permission denied/i, D));
test("the client role cannot read or write publishing tokens", async () => {
  await mustFail(`select * from action_connections`, /permission denied/i, D);
  await mustFail(`insert into action_connections (user_id, kind, provider, label, token_ct, data_key_id)
                  values ('${D}','hosting','netlify','x','\\x00','k')`, /permission denied/i, D);
});

test("a user's disclosure survives a delete attempt", async () => {
  await asUser(D, async () => { await db.query(`delete from connection_disclosures where user_id='${D}'`); });
  assert.equal(await count(`select count(*)::int n from connection_disclosures where user_id='${D}'`), 1);
});

/* ---- conflict query and append-only audit ---- */

test("the conflict-overlap query runs against events_cache", () =>
  mustSucceed(`select 1 from events_cache where user_id='${D}'
                 and tstzrange(start_time,end_time,'[)') && tstzrange(now(), now() + interval '1 hour','[)') limit 1`));

test("audit_log ignores update and delete", async () => {
  await db.exec(`update audit_log set action = 'tampered'; delete from audit_log;`);
  assert.equal(await count(`select count(*)::int n from audit_log where action='test.action'`), 1);
});

test("a user's data can be removed table by table, as the account-deletion route does", async () => {
  // Mirrors USER_DATA_TABLES in server/routes.ts. If a table gains a user_id column and is not
  // added there, this fails to leave the user with zero rows and the gap is caught here.
  const tables = ["safety_events", "habit_observations", "habit_profiles", "proposed_events",
    "events_cache", "connection_disclosures", "oauth_connections", "action_connections", "user_settings"];
  for (const t of tables) await db.query(`delete from ${t} where user_id = $1`, [D]);
  let remaining = 0;
  const { rows } = await db.query<{ table_name: string }>(
    `select table_name from information_schema.columns
      where table_schema='public' and column_name='user_id' and table_name <> 'audit_log'`);
  for (const r of rows) remaining += await count(`select count(*)::int n from ${r.table_name} where user_id='${D}'`);
  assert.equal(remaining, 0);
  assert.deepEqual(rows.map((r) => r.table_name).filter((n) => !tables.includes(n)), [],
    "a table holds user_id but is missing from the account-deletion list");
});
