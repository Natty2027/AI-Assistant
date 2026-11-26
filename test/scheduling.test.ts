/**
 * Ongoing posts, invites and reminder emails. A post can be approved now and go out at its time:
 * checked when approved, held, checked again when due, posted once (even with two servers running
 * during a deploy), and cancellable until then. Emails can carry a calendar invite and a time to
 * be reminded to send them.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { ActionStore, sqlProposalSink } = await import("../server/agent/approvals.ts");
const { scheduleChecks } = await import("../server/agent/policy.ts");
const { makeIcs, IcsError } = await import("../server/agent/ics.ts");
const { runAgent, AGENT_MODEL } = await import("../server/agent/loop.ts");
const { readLocalTime } = await import("../server/agent/service.ts");
const { makeCtx } = await import("./helpers/agentCtx.ts");

const U = "00000000-0000-0000-0000-0000000000c9";
let run: Awaited<ReturnType<typeof makeDb>>["run"];
before(async () => {
  const ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, U);
});

const T0 = new Date("2026-11-19T17:00:00Z");
const post = (postAt: string, over: Record<string, unknown> = {}) =>
  ({ connectionId: "x1", text: "Open house Saturday, 10 to 2!", link: null, sponsored: false, mediaRefs: [], postAt, ...over });

/* ---------------- scheduled posts ---------------- */

test("a post's time must be real, ahead, within 90 days, and within 6 days with a photo", () => {
  assert.deepEqual(scheduleChecks("2026-11-21T09:00:00-08:00", 0, T0), []);
  assert.equal(scheduleChecks("2026-11-19T08:00:00-08:00", 0, T0)[0].id, "past_time");
  assert.equal(scheduleChecks("2027-03-01T09:00:00-08:00", 0, T0)[0].id, "far_time");
  assert.equal(scheduleChecks("2026-11-28T09:00:00-08:00", 1, T0)[0].id, "photo_time");
  assert.equal(scheduleChecks("next friday", 0, T0)[0].id, "bad_time");
  assert.equal(scheduleChecks("2026-11-21T09:00:00", 0, T0)[0].id, "bad_time", "needs an offset");
});

test("approve now, post at its time, exactly once; it can't be posted early", async () => {
  let now = T0;
  const store = new ActionStore(() => now);
  const p = store.propose({ userId: U, kind: "social.post", payload: post("2026-11-21T17:00:00Z"), summary: "Saturday", tainted: false, ctx: makeCtx() });
  assert.equal(p.status, "pending");
  const { token } = store.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  await assert.rejects(store.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: async () => ({ ok: true, detail: "" }) }), { code: "scheduled" });

  const scheduled = store.schedule({ id: p.id, userId: U, token, ctx: makeCtx() });
  assert.equal(scheduled.status, "scheduled");
  assert.deepEqual(store.due(), [], "not yet");

  now = new Date("2026-11-21T17:00:30Z");
  assert.deepEqual(store.due(), [{ id: p.id, userId: U }]);
  let posts = 0;
  const done = await store.runScheduled({ id: p.id, userId: U, ctx: makeCtx(), executor: async () => { posts++; return { ok: true, detail: "Posted" }; } });
  assert.equal(done?.status, "executed");
  assert.equal(await store.runScheduled({ id: p.id, userId: U, ctx: makeCtx(), executor: async () => { posts++; return { ok: true, detail: "" }; } }), null);
  assert.equal(posts, 1);
  assert.deepEqual(store.due(), []);
});

test("a scheduled post can be cancelled, and is checked again when due", async () => {
  let now = T0;
  const store = new ActionStore(() => now);
  const ctx = makeCtx();
  const a = store.propose({ userId: U, kind: "social.post", payload: post("2026-11-20T17:00:00Z"), summary: "A", tainted: false, ctx });
  const b = store.propose({ userId: U, kind: "social.post", payload: post("2026-11-20T18:00:00Z", { text: "Second post" }), summary: "B", tainted: false, ctx });
  for (const p of [a, b]) store.schedule({ id: p.id, userId: U, token: store.approve({ id: p.id, userId: U, payloadHash: p.payloadHash }).token, ctx });
  store.reject(a.id, U);
  assert.equal(store.get(a.id, U).status, "rejected");

  now = new Date("2026-11-20T19:00:00Z");
  assert.deepEqual(store.due().map((d) => d.id), [b.id], "the cancelled one never goes");
  // By then the account has posted its fill for the day: the rule stops it.
  const busy = makeCtx({ usageToday: { "social.post:x1": 99 } });
  const out = await store.runScheduled({ id: b.id, userId: U, ctx: busy, executor: async () => ({ ok: true, detail: "" }) });
  assert.equal(out?.status, "blocked");
  assert.match(out!.result!.detail, /Not posted: .*Daily limit/);
});

test("with two servers running (a deploy), only one posts it", async () => {
  let now = T0;
  const sinkA = sqlProposalSink(run);
  const a = new ActionStore(() => now, sinkA);
  const p = a.propose({ userId: U, kind: "social.post", payload: post("2026-11-20T17:00:00Z", { text: "Once only" }), summary: "Once", tainted: false, ctx: makeCtx() });
  a.schedule({ id: p.id, userId: U, token: a.approve({ id: p.id, userId: U, payloadHash: p.payloadHash }).token, ctx: makeCtx() });
  await a.flush();
  const sinkB = sqlProposalSink(run);
  const b = new ActionStore(() => now, sinkB);
  b.restore(await sinkB.load());

  now = new Date("2026-11-20T17:01:00Z");
  let posts = 0;
  const executor = async () => { posts++; return { ok: true, detail: "Posted" }; };
  const [ra, rb] = await Promise.all([
    a.runScheduled({ id: p.id, userId: U, ctx: makeCtx(), executor }),
    b.runScheduled({ id: p.id, userId: U, ctx: makeCtx(), executor }),
  ]);
  assert.equal(posts, 1);
  assert.equal([ra, rb].filter(Boolean).length, 1);
  await a.flush(); await b.flush();
});

test("Hera schedules posts, attaches invites, sets reminder times, and knows the person's clock", async () => {
  const msg = (content: any[], stop_reason = "tool_use") => ({ id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }) as any;
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
  const calls: any[] = [];
  const steps = [
    () => msg([use("p1", "draft_post", { connection_id: "x1", text: "Open house Saturday!", link: null, sponsored: false, attach_photo: false, post_at: "2026-11-21T09:00:00-08:00" })]),
    () => msg([use("e1", "draft_email", { to: [], cc: [], subject: "Open house Saturday", body: "Join us!", send_at: "2026-11-20T09:00:00-08:00",
      invite: { title: "Open House", start: "2026-11-22T10:00:00-08:00", end: "2026-11-22T14:00:00-08:00", location: "Clay Corner, 12 Main St", description: null } })]),
    () => msg([{ type: "text", text: "Done." }], "end_turn"),
  ];
  const client = { beta: { messages: { create: async (p: any) => { calls.push(structuredClone(p)); return steps[calls.length - 1](); } } } };
  const out = await runAgent({ mode: "launch", client, store: new ActionStore(), userId: "u1", context: () => makeCtx(),
    localTime: { now: "2026-11-19T09:00:00-08:00", timeZone: "America/Los_Angeles" } } as any, "Launch Saturday's open house");

  assert.match(calls[0].system, /It is now 2026-11-19T09:00:00-08:00 in the person's time zone \(America\/Los_Angeles\)/);
  assert.equal(out.drafts[0].postAt, "2026-11-21T09:00:00-08:00");
  const email = out.emailDrafts[0];
  assert.equal(email.sendAt, "2026-11-20T09:00:00-08:00");
  assert.match(email.invite!.ics, /DTSTART:20261122T180000Z\r\nDTEND:20261122T220000Z/);
});

/* ---------------- invites ---------------- */

test("an invite is a valid calendar file in UTC, with text escaped and long lines folded", () => {
  const ics = makeIcs({ title: "Open House, tours; snacks", start: "2026-11-22T10:00:00-08:00", end: "2026-11-22T14:00:00-08:00",
    location: "Clay Corner, 12 Main St", description: "Line one\nLine two " + "x".repeat(100) }, T0);
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.match(ics, /METHOD:PUBLISH/);
  assert.match(ics, /DTSTART:20261122T180000Z/);
  assert.ok(ics.includes("SUMMARY:Open House\\, tours\\; snacks\r\n"), "commas and semicolons escaped");
  assert.match(ics, /DESCRIPTION:Line one\\nLine two/);
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines folded at 75 octets");
  assert.match(ics, /\r\n /, "a folded line continues with a space");
  assert.throws(() => makeIcs({ title: "x", start: "2026-11-22T14:00:00-08:00", end: "2026-11-22T10:00:00-08:00", location: null, description: null }), IcsError);
  assert.throws(() => makeIcs({ title: "x", start: "Saturday at 10", end: "2026-11-22T10:00:00-08:00", location: null, description: null }), IcsError);
});

test("the person's clock is read only when well formed", () => {
  assert.deepEqual(readLocalTime({ now: "2026-11-19T09:00:00-08:00", time_zone: "America/Los_Angeles" }), { now: "2026-11-19T09:00:00-08:00", timeZone: "America/Los_Angeles" });
  assert.equal(readLocalTime({ now: "yesterday", time_zone: "America/Los_Angeles" }), null);
  assert.equal(readLocalTime({ now: "2026-11-19T09:00:00-08:00", time_zone: "<script>" }), null);
});
