/**
 * The provider layer, against a fake Google/Microsoft. No network, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// envelope.ts reads the master key through config at import time, so set it first.
process.env.MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const { createEvent, listEvents, freshAccessToken, categorize, ProviderError } = await import("../server/calendar.ts");
const { encryptToken, decryptToken, newDataKeyId } = await import("../server/crypto/envelope.ts");
import type { StoredConn, FetchLike } from "../server/calendar.ts";

interface Call { url: string; method: string; headers: Record<string, string>; body: any }

/** A fetch that records what it was asked and answers from a script. */
function fakeFetch(answer: (c: Call) => Response | Promise<Response> | Error): { f: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body?.toString(),
    };
    calls.push(call);
    const out = await answer(call);
    if (out instanceof Error) throw out;
    return out;
  };
  return { f, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ev = {
  title: "Dentist", start: new Date("2026-11-10T15:00:00Z"), end: new Date("2026-11-10T16:00:00Z"),
  allDay: false, location: "12 Main St", description: "bring card",
};

/* ---------- creating events ---------- */

test("google: a timed event posts RFC3339 times with the bearer token", async () => {
  const { f, calls } = fakeFetch(() => json({ id: "g1" }));
  assert.equal(await createEvent("google", "tok", ev, f), "g1");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /googleapis\.com\/calendar\/v3\/calendars\/primary\/events$/);
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  assert.deepEqual(calls[0].body.start, { dateTime: "2026-11-10T15:00:00.000Z" });
  assert.equal(calls[0].body.summary, "Dentist");
  assert.equal(calls[0].body.location, "12 Main St");
});

test("google: an all-day event uses dates, with an exclusive end", async () => {
  const { f, calls } = fakeFetch(() => json({ id: "g2" }));
  await createEvent("google", "t", { ...ev, allDay: true, start: new Date("2026-11-10T00:00:00Z"), end: new Date("2026-11-10T00:00:00Z") }, f);
  assert.deepEqual(calls[0].body.start, { date: "2026-11-10" });
  assert.deepEqual(calls[0].body.end, { date: "2026-11-11" }, "a one-day event must end the next day or Google rejects it");
});

test("microsoft: wall-clock times in UTC, no trailing Z", async () => {
  const { f, calls } = fakeFetch(() => json({ id: "m1" }));
  assert.equal(await createEvent("microsoft", "tok", ev, f), "m1");
  assert.match(calls[0].url, /graph\.microsoft\.com\/v1\.0\/me\/events$/);
  assert.deepEqual(calls[0].body.start, { dateTime: "2026-11-10T15:00:00.000", timeZone: "UTC" });
  assert.equal(calls[0].body.subject, "Dentist");
  assert.deepEqual(calls[0].body.location, { displayName: "12 Main St" });
});

test("provider failures are classified without exposing a response body", async () => {
  const kind = async (status: number) => {
    const { f } = fakeFetch(() => new Response("secret echo of the request", { status }));
    try { await createEvent("google", "t", ev, f); return "no error"; }
    catch (e) { assert.ok(e instanceof ProviderError); assert.doesNotMatch(e.message, /secret/); return e.kind; }
  };
  assert.equal(await kind(401), "unauthorized");
  assert.equal(await kind(403), "unauthorized");
  assert.equal(await kind(400), "rejected");
  assert.equal(await kind(409), "rejected");
  assert.equal(await kind(429), "unavailable");
  assert.equal(await kind(503), "unavailable");
});

test("a network failure is 'unavailable', not a crash", async () => {
  const { f } = fakeFetch(() => new Error("ECONNRESET"));
  await assert.rejects(() => createEvent("google", "t", ev, f), (e: any) => e instanceof ProviderError && e.kind === "unavailable");
});

test("a created event with no id is treated as a failure, not silently accepted", async () => {
  const { f } = fakeFetch(() => json({}));
  await assert.rejects(() => createEvent("google", "t", ev, f), (e: any) => e instanceof ProviderError);
});

/* ---------- token refresh ---------- */

const cfg = { clientId: "cid", clientSecret: "sec", authUrl: "x", tokenUrl: "https://oauth.test/token", scopes: [] };

function conn(over: Partial<StoredConn> = {}, access = "old-access", refresh: string | null = "old-refresh") {
  const keyId = newDataKeyId();
  return {
    id: "c1", provider: "google", data_key_id: keyId,
    access_token_ct: encryptToken(access, keyId),
    refresh_token_ct: refresh ? encryptToken(refresh, keyId) : null,
    expires_at: new Date(Date.now() + 3_600_000),
    ...over,
  } as StoredConn;
}
function store() {
  const saved: Array<{ access: Buffer; refresh: Buffer | null; expiresAt: Date }> = [];
  return { saved, save: async (_id: string, access: Buffer, refresh: Buffer | null, expiresAt: Date) => { saved.push({ access, refresh, expiresAt }); } };
}

test("a still-valid token is used as is, with no network call", async () => {
  const { f, calls } = fakeFetch(() => json({}));
  const s = store();
  assert.equal(await freshAccessToken(conn(), cfg, s, f), "old-access");
  assert.equal(calls.length, 0);
  assert.equal(s.saved.length, 0);
});

test("an expired token is refreshed, re-encrypted, and saved", async () => {
  const c = conn({ expires_at: new Date(Date.now() - 1000) });
  const { f, calls } = fakeFetch(() => json({ access_token: "new-access", expires_in: 1800 }));
  const s = store();
  assert.equal(await freshAccessToken(c, cfg, s, f), "new-access");
  assert.equal(calls[0].url, "https://oauth.test/token");
  assert.match(String(calls[0].body), /grant_type=refresh_token/);
  assert.match(String(calls[0].body), /refresh_token=old-refresh/, "must send the DECRYPTED refresh token");
  assert.equal(decryptToken(s.saved[0].access, c.data_key_id), "new-access");
  assert.equal(decryptToken(s.saved[0].refresh!, c.data_key_id), "old-refresh", "no rotation: the old refresh token is kept");
});

test("a rotated refresh token replaces the old one (Microsoft)", async () => {
  const c = conn({ expires_at: new Date(0) });
  const { f } = fakeFetch(() => json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }));
  const s = store();
  await freshAccessToken(c, cfg, s, f);
  assert.equal(decryptToken(s.saved[0].refresh!, c.data_key_id), "r2");
});

test("a token inside the safety margin is refreshed rather than risked", async () => {
  const c = conn({ expires_at: new Date(Date.now() + 10_000) });
  const { f, calls } = fakeFetch(() => json({ access_token: "fresh", expires_in: 3600 }));
  assert.equal(await freshAccessToken(c, cfg, store(), f), "fresh");
  assert.equal(calls.length, 1);
});

test("a revoked grant (400 from the token endpoint) is 'unauthorized'", async () => {
  const c = conn({ expires_at: new Date(0) });
  const { f } = fakeFetch(() => json({ error: "invalid_grant" }, 400));
  await assert.rejects(() => freshAccessToken(c, cfg, store(), f), (e: any) => e instanceof ProviderError && e.kind === "unauthorized");
});

test("an expired token with no refresh token is 'unauthorized', not a crash", async () => {
  const c = conn({ expires_at: new Date(0) }, "a", null);
  await assert.rejects(() => freshAccessToken(c, cfg, store(), fakeFetch(() => json({})).f),
    (e: any) => e instanceof ProviderError && e.kind === "unauthorized");
});

/* ---------- listing ---------- */

test("google: cancelled events are skipped, free and all-day events are not 'busy'", async () => {
  const { f, calls } = fakeFetch(() => json({ items: [
    { id: "1", summary: "Systems lecture", start: { dateTime: "2026-11-10T15:00:00Z" }, end: { dateTime: "2026-11-10T16:00:00Z" } },
    { id: "2", summary: "Cancelled thing", status: "cancelled", start: { dateTime: "2026-11-10T15:00:00Z" }, end: { dateTime: "2026-11-10T16:00:00Z" } },
    { id: "3", summary: "Lunch", transparency: "transparent", start: { dateTime: "2026-11-10T17:00:00Z" }, end: { dateTime: "2026-11-10T18:00:00Z" } },
    { id: "4", summary: "Sam's birthday", start: { date: "2026-11-10" }, end: { date: "2026-11-11" } },
    { id: "5", summary: "Midterm exam", start: { date: "2026-11-10" }, end: { date: "2026-11-11" } },
  ] }));
  const out = await listEvents("google", "t", new Date("2026-11-10T00:00:00Z"), new Date("2026-11-17T00:00:00Z"), f);
  assert.match(calls[0].url, /singleEvents=true/);
  assert.deepEqual(out.map((e) => e.id), ["1", "3", "4", "5"]);
  const by = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.equal(by["1"].busy, true);
  assert.equal(by["1"].category, "class");
  assert.equal(by["3"].busy, false, "free-marked events do not make someone unavailable");
  assert.equal(by["4"].allDay, true);
  assert.equal(by["4"].busy, false, "an all-day birthday does not silence the assistant for 24 hours");
  assert.equal(by["5"].busy, true, "an all-day exam does");
  assert.equal(by["5"].category, "exam");
});

test("microsoft: UTC text without a zone suffix is read as UTC, and free/cancelled are handled", async () => {
  const { f, calls } = fakeFetch(() => json({ value: [
    { id: "a", subject: "Team sync", start: { dateTime: "2026-11-10T15:00:00.0000000" }, end: { dateTime: "2026-11-10T15:30:00.0000000" }, showAs: "busy" },
    { id: "b", subject: "Gone", isCancelled: true, start: { dateTime: "2026-11-10T15:00:00.0000000" }, end: { dateTime: "2026-11-10T16:00:00.0000000" } },
    { id: "c", subject: "Maybe", showAs: "free", start: { dateTime: "2026-11-10T20:00:00.0000000" }, end: { dateTime: "2026-11-10T21:00:00.0000000" } },
  ] }));
  const out = await listEvents("microsoft", "t", new Date("2026-11-10T00:00:00Z"), new Date("2026-11-17T00:00:00Z"), f);
  assert.equal(calls[0].headers.Prefer, 'outlook.timezone="UTC"');
  assert.deepEqual(out.map((e) => e.id), ["a", "c"]);
  assert.equal(out[0].start.toISOString(), "2026-11-10T15:00:00.000Z");
  assert.equal(out[0].category, "meeting");
  assert.equal(out[1].busy, false);
});

test("an event with an unreadable date is dropped, not stored as Invalid Date", async () => {
  const { f } = fakeFetch(() => json({ items: [{ id: "x", summary: "Broken", start: { dateTime: "not a date" }, end: { dateTime: "also not" } }] }));
  assert.deepEqual(await listEvents("google", "t", new Date(), new Date(), f), []);
});

test("categorize leans quiet, and does not call a 'final project' an exam", () => {
  assert.equal(categorize("CS101 Midterm Exam"), "exam");
  assert.equal(categorize("Final exam: Bio"), "exam");
  assert.equal(categorize("final project work"), "other");
  assert.equal(categorize("Physics lab"), "class");
  assert.equal(categorize("1:1 with Priya"), "meeting");
  assert.equal(categorize("Focus time"), "focus_block");
  assert.equal(categorize("Dentist"), "other");
});
