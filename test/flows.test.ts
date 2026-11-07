/**
 * Confirm-a-proposal, calendar sync and connection storage, run against real SQL (PGlite with
 * the project's schema) and a fake provider. These are the paths where a bug either creates a
 * duplicate event on someone's calendar or silently loses one, so they get the heaviest tests.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { saveConnection, loadConnections } = await import("../server/connections.ts");
const { confirmProposal, rejectProposal, listPending } = await import("../server/proposals.ts");
const { syncUser } = await import("../server/sync.ts");
const { encryptToken } = await import("../server/crypto/envelope.ts");
const { newDataKeyId } = await import("../server/crypto/envelope.ts");
import type { FetchLike } from "../server/calendar.ts";

const U1 = "00000000-0000-0000-0000-000000000001";
const U2 = "00000000-0000-0000-0000-000000000002";
const cfg = { clientId: "cid", clientSecret: "sec", authUrl: "x", tokenUrl: "https://oauth.test/token", scopes: [] };
const CFG = { google: cfg, microsoft: cfg };

let ctx: Awaited<ReturnType<typeof makeDb>>;
let run: Awaited<ReturnType<typeof makeDb>>["run"];

before(async () => {
  ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, U1);
  await addUser(ctx.db, U2);
  // The disclosure gate applies to tests too: nobody connects without acknowledging.
  for (const u of [U1, U2]) for (const p of ["google", "microsoft"]) {
    await run(`insert into connection_disclosures (user_id, provider, disclosure_version) values ($1,$2,1)`, [u, p]);
  }
});

/* ---- helpers ---- */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function provider(answer: (url: string, init: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: any }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body });
    return answer(String(url), init);
  };
  return { f, calls };
}

async function connect(user: string, p: "google" | "microsoft", email: string | null, opts: { expired?: boolean; refresh?: boolean } = {}) {
  const keyId = newDataKeyId();
  const id = await saveConnection(run, {
    userId: user, provider: p, email,
    accessCt: encryptToken("access-" + p, keyId),
    refreshCt: opts.refresh === false ? null : encryptToken("refresh-" + p, keyId),
    dataKeyId: keyId, scopes: ["cal"],
    expiresInSeconds: opts.expired ? -3600 : 3600,
  });
  return id;
}

async function propose(user: string, over: Record<string, unknown> = {}) {
  const v = { title: "Dentist", start: "2026-11-10T15:00:00Z", end: "2026-11-10T16:00:00Z", all_day: false, ...over };
  const { rows } = await run(
    `insert into proposed_events (user_id, source, title, start_time, end_time, all_day, location)
     values ($1,'vision',$2,$3,$4,$5,$6) returning id`,
    [user, v.title, v.start, v.end, v.all_day, v.location ?? null]
  );
  return rows[0].id as string;
}

const row = async (id: string) => (await run(`select * from proposed_events where id=$1`, [id])).rows[0];
const clean = async () => {
  await run(`delete from proposed_events`);
  await run(`delete from oauth_connections`);
  await run(`delete from events_cache`);
};
const deps = (f: FetchLike) => ({ run, fetch: f, cfg: CFG });

/* ================= connections ================= */

test("a connection cannot be saved without a disclosure on file", async () => {
  await clean();
  await run(`delete from connection_disclosures where user_id=$1 and provider='microsoft'`, [U1]);
  await assert.rejects(() => connect(U1, "microsoft", "a@b.c"), /no current disclosure/i);
  await run(`insert into connection_disclosures (user_id, provider, disclosure_version) values ($1,'microsoft',1)`, [U1]);
});

test("reconnecting the same account updates the one row instead of failing on the unique key", async () => {
  await clean();
  const first = await connect(U1, "google", "me@x.com", { expired: true });
  const second = await connect(U1, "google", "me@x.com");
  assert.equal(second, first, "same account, same row");
  const { rows } = await run(`select expires_at from oauth_connections where user_id=$1`, [U1]);
  assert.equal(rows.length, 1);
  assert.ok(new Date(rows[0].expires_at) > new Date(), "the new, valid expiry replaced the old one");
});

test("reconnecting clears a revoked flag so syncing resumes", async () => {
  await clean();
  const id = await connect(U1, "google", "me@x.com");
  await run(`update oauth_connections set revoked_at = now() where id=$1`, [id]);
  assert.equal((await loadConnections(run, U1)).length, 0, "a revoked connection is not used");
  await connect(U1, "google", "me@x.com");
  assert.equal((await loadConnections(run, U1)).length, 1);
});

test("with no email on file, a reconnect replaces the old row rather than piling up", async () => {
  await clean();
  await connect(U1, "google", null);
  await connect(U1, "google", null);
  assert.equal((await run(`select count(*)::int n from oauth_connections where user_id=$1`, [U1])).rows[0].n, 1);
});

test("a user's connections are never visible to another user", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  assert.equal((await loadConnections(run, U2)).length, 0);
});

/* ================= confirming ================= */

test("confirming writes exactly one event and records its id", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1, { location: "12 Main St" });
  const p = provider(() => json({ id: "evt-123" }));

  const out = await confirmProposal(deps(p.f), U1, id, {});

  assert.deepEqual(out, { eventId: "evt-123", provider: "google" });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].body.summary, "Dentist");
  const r = await row(id);
  assert.equal(r.status, "confirmed");
  assert.equal(r.written_event_id, "evt-123");
  assert.ok(r.confirmed_at);
});

test("two simultaneous confirms create ONE event; the loser is told it was already handled", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1);
  const p = provider(async () => { await new Promise((r) => setTimeout(r, 30)); return json({ id: "only-one" }); });

  const results = await Promise.allSettled([
    confirmProposal(deps(p.f), U1, id, {}),
    confirmProposal(deps(p.f), U1, id, {}),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(lost.reason.status, 409);
  assert.equal(p.calls.length, 1, "the provider was called once, not twice");
});

test("confirming twice in sequence is refused, not repeated", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1);
  const p = provider(() => json({ id: "e1" }));
  await confirmProposal(deps(p.f), U1, id, {});
  await assert.rejects(() => confirmProposal(deps(p.f), U1, id, {}), (e: any) => e.status === 409);
  assert.equal(p.calls.length, 1);
});

test("a provider that rejects the event releases the claim so the user can retry", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1);
  const bad = provider(() => json({ error: "bad" }, 400));
  await assert.rejects(() => confirmProposal(deps(bad.f), U1, id, {}), (e: any) => e.status === 422);

  const r = await row(id);
  assert.equal(r.status, "pending_confirmation", "back to waiting, not stuck as confirmed");
  assert.equal(r.written_event_id, null);
  assert.equal(r.confirmed_at, null);

  const good = provider(() => json({ id: "second-try" }));
  assert.equal((await confirmProposal(deps(good.f), U1, id, {})).eventId, "second-try");
});

test("an unreachable provider writes nothing and leaves the suggestion pending", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1);
  const down = provider(() => json({}, 503));
  await assert.rejects(() => confirmProposal(deps(down.f), U1, id, {}), (e: any) => e.status === 502);
  assert.equal((await row(id)).status, "pending_confirmation");
});

test("a lapsed sign-in marks the connection revoked, asks to reconnect, and keeps the suggestion", async () => {
  await clean();
  const connId = await connect(U1, "google", "me@x.com");
  const id = await propose(U1);
  const lapsed = provider(() => json({}, 401));
  await assert.rejects(() => confirmProposal(deps(lapsed.f), U1, id, {}),
    (e: any) => e.status === 409 && e.code === "reconnect_needed");
  assert.equal((await row(id)).status, "pending_confirmation");
  const c = (await run(`select revoked_at from oauth_connections where id=$1`, [connId])).rows[0];
  assert.ok(c.revoked_at, "stop using a grant the provider says is gone");
});

test("an expired access token is refreshed before the event is written", async () => {
  await clean();
  await connect(U1, "google", "me@x.com", { expired: true });
  const id = await propose(U1);
  const p = provider((url) => url.includes("oauth.test") ? json({ access_token: "fresh", expires_in: 3600 }) : json({ id: "after-refresh" }));
  const out = await confirmProposal(deps(p.f), U1, id, {});
  assert.equal(out.eventId, "after-refresh");
  assert.deepEqual(p.calls.map((c) => c.url.includes("oauth.test") ? "refresh" : "create"), ["refresh", "create"]);
});

test("a timed event with no end time is refused WITHOUT calling the provider", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1, { end: null });
  const p = provider(() => json({ id: "x" }));
  await assert.rejects(() => confirmProposal(deps(p.f), U1, id, {}), (e: any) => e.status === 400 && e.code === "needs_end_time");
  assert.equal(p.calls.length, 0, "a duration is never assumed");
  assert.equal((await row(id)).status, "pending_confirmation");
});

test("the user can supply the missing end time and it is what gets written", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1, { end: null });
  const p = provider(() => json({ id: "fixed" }));
  await confirmProposal(deps(p.f), U1, id, { end: "2026-11-10T15:45:00Z" });
  assert.equal(p.calls[0].body.end.dateTime, "2026-11-10T15:45:00.000Z");
  assert.equal(new Date((await row(id)).end_time).toISOString(), "2026-11-10T15:45:00.000Z");
});

test("a proposal with no start time cannot be confirmed", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1, { start: null, end: null });
  const p = provider(() => json({ id: "x" }));
  await assert.rejects(() => confirmProposal(deps(p.f), U1, id, {}), (e: any) => e.code === "needs_start_time");
  assert.equal(p.calls.length, 0);
});

test("an end before the start is refused", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1);
  const p = provider(() => json({ id: "x" }));
  await assert.rejects(() => confirmProposal(deps(p.f), U1, id, { end: "2026-11-10T14:00:00Z" }), (e: any) => e.code === "bad_range");
  assert.equal(p.calls.length, 0);
});

test("with no calendar connected, the user is told to connect one and the suggestion is untouched", async () => {
  await clean();
  const id = await propose(U1);
  const p = provider(() => json({ id: "x" }));
  await assert.rejects(() => confirmProposal(deps(p.f), U1, id, {}), (e: any) => e.status === 409 && e.code === "no_calendar");
  assert.equal((await row(id)).status, "pending_confirmation");
  assert.equal(p.calls.length, 0);
});

test("with two calendars connected the user must choose; choosing writes only to that one", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  await connect(U1, "microsoft", "me@work.com");
  const id = await propose(U1);
  const p = provider(() => json({ id: "ms-1" }));
  await assert.rejects(() => confirmProposal(deps(p.f), U1, id, {}), (e: any) => e.code === "choose_calendar");
  assert.equal(p.calls.length, 0);

  const out = await confirmProposal(deps(p.f), U1, id, { provider: "microsoft" });
  assert.equal(out.provider, "microsoft");
  assert.match(p.calls[0].url, /graph\.microsoft\.com/);
  assert.equal(p.calls.length, 1);
});

test("one user cannot confirm, reject or list another user's suggestion", async () => {
  await clean();
  await connect(U2, "google", "u2@x.com");
  const id = await propose(U1);
  const p = provider(() => json({ id: "x" }));
  await assert.rejects(() => confirmProposal(deps(p.f), U2, id, {}), (e: any) => e.status === 404);
  await assert.rejects(() => rejectProposal(run, U2, id), (e: any) => e.status === 404);
  assert.equal((await listPending(run, U2)).length, 0);
  assert.equal(p.calls.length, 0);
  assert.equal((await row(id)).status, "pending_confirmation");
});

test("a malformed id is rejected before touching the database", async () => {
  await assert.rejects(() => confirmProposal(deps(provider(() => json({})).f), U1, "1; drop table x", {}), (e: any) => e.status === 400);
  await assert.rejects(() => rejectProposal(run, U1, "nope"), (e: any) => e.status === 400);
});

test("rejecting removes it from the pending list and cannot be undone by confirming", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const id = await propose(U1);
  assert.equal((await listPending(run, U1)).length, 1);
  await rejectProposal(run, U1, id);
  assert.equal((await listPending(run, U1)).length, 0);
  const p = provider(() => json({ id: "x" }));
  await assert.rejects(() => confirmProposal(deps(p.f), U1, id, {}), (e: any) => e.status === 409);
  assert.equal(p.calls.length, 0);
});

test("the database refuses an event id on an unconfirmed proposal even if the code were wrong", async () => {
  await clean();
  const id = await propose(U1);
  await assert.rejects(() => run(`update proposed_events set written_event_id='sneaky' where id=$1`, [id]), /no_write_without_confirmation|check/i);
});

/* ================= sync ================= */

const gEvents = (items: unknown[]) => provider((url) => url.includes("googleapis.com") ? json({ items }) : json({}));
const NOW = new Date("2026-11-10T14:00:00Z");
const g = (id: string, summary: string, s: string, e: string, extra = {}) =>
  ({ id, summary, start: { dateTime: s }, end: { dateTime: e }, ...extra });

test("sync stores events, and the resolver's 'active now' query finds the one in progress", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  const p = gEvents([
    g("a", "Systems lecture", "2026-11-10T13:30:00Z", "2026-11-10T14:30:00Z"),
    g("b", "Dinner", "2026-11-10T22:00:00Z", "2026-11-10T23:00:00Z"),
  ]);
  const r = await syncUser(deps(p.f), U1, NOW);
  assert.deepEqual(r, { synced: 2, reconnect: [], failed: [] });
  const { rows } = await run(
    `select title, category from events_cache where user_id=$1 and busy and start_time <= $2 and end_time > $2`, [U1, NOW.toISOString()]);
  assert.deepEqual(rows.map((x) => [x.title, x.category]), [["Systems lecture", "class"]]);
});

test("a repeat sync updates in place and removes events deleted upstream", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  await syncUser(deps(gEvents([g("a", "Old title", "2026-11-10T15:00:00Z", "2026-11-10T16:00:00Z"),
                               g("gone", "Cancelled later", "2026-11-11T15:00:00Z", "2026-11-11T16:00:00Z")]).f), U1, NOW);
  await new Promise((r) => setTimeout(r, 5));
  await syncUser(deps(gEvents([g("a", "New title", "2026-11-10T15:00:00Z", "2026-11-10T16:00:00Z")]).f), U1, NOW);
  const { rows } = await run(`select provider_event_id, title from events_cache where user_id=$1 order by 1`, [U1]);
  assert.deepEqual(rows.map((x) => [x.provider_event_id, x.title]), [["a", "New title"]]);
});

test("sync leaves seeded staging rows alone", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  await run(`insert into events_cache (user_id, provider, provider_event_id, title, start_time, end_time)
             values ($1,'google','dev-123','Seeded','2026-11-10T14:00:00Z','2026-11-10T15:00:00Z')`, [U1]);
  await syncUser(deps(gEvents([]).f), U1, NOW);
  assert.equal((await run(`select count(*)::int n from events_cache where provider_event_id='dev-123'`)).rows[0].n, 1);
});

test("sync does not delete history from before its window", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  await run(`insert into events_cache (user_id, provider, provider_event_id, title, start_time, end_time)
             values ($1,'google','old','Last week','2026-11-01T14:00:00Z','2026-11-01T15:00:00Z')`, [U1]);
  await syncUser(deps(gEvents([]).f), U1, NOW);
  assert.equal((await run(`select count(*)::int n from events_cache where provider_event_id='old'`)).rows[0].n, 1);
});

test("a lapsed provider is marked revoked and reported, while the other provider still syncs", async () => {
  await clean();
  const gid = await connect(U1, "google", "me@x.com");
  await connect(U1, "microsoft", "me@work.com");
  const p = provider((url) =>
    url.includes("googleapis.com") ? json({}, 401)
    : json({ value: [{ id: "m1", subject: "Team sync", start: { dateTime: "2026-11-10T15:00:00.0000000" }, end: { dateTime: "2026-11-10T15:30:00.0000000" } }] }));
  const r = await syncUser(deps(p.f), U1, NOW);
  assert.deepEqual(r.reconnect, ["google"]);
  assert.equal(r.synced, 1);
  assert.ok((await run(`select revoked_at from oauth_connections where id=$1`, [gid])).rows[0].revoked_at);
  assert.equal((await run(`select count(*)::int n from events_cache where provider='microsoft'`)).rows[0].n, 1);
});

test("a provider outage is reported as failed and does not delete the cached events", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  await syncUser(deps(gEvents([g("a", "Keep me", "2026-11-10T15:00:00Z", "2026-11-10T16:00:00Z")]).f), U1, NOW);
  const r = await syncUser(deps(provider(() => json({}, 503)).f), U1, NOW);
  assert.deepEqual(r.failed, ["google"]);
  assert.equal((await run(`select count(*)::int n from events_cache where provider_event_id='a'`)).rows[0].n, 1,
    "an outage must not look like an empty calendar");
});

test("sync only ever touches the requesting user's data", async () => {
  await clean();
  await connect(U1, "google", "me@x.com");
  await connect(U2, "google", "u2@x.com");
  await run(`insert into events_cache (user_id, provider, provider_event_id, title, start_time, end_time)
             values ($1,'google','theirs','U2 event','2026-11-10T15:00:00Z','2026-11-10T16:00:00Z')`, [U2]);
  await syncUser(deps(gEvents([]).f), U1, NOW);
  assert.equal((await run(`select count(*)::int n from events_cache where user_id=$1`, [U2])).rows[0].n, 1);
});
