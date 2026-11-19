/**
 * Approvals and finished runs survive a restart: everything is written through to the database
 * and read back when the server starts. An action that was being carried out when the server
 * stopped is never run again on its own, and a server stopping waits for runs in flight.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { ActionStore, sqlProposalSink } = await import("../server/agent/approvals.ts");
const { RunJobs, sqlRunSink } = await import("../server/agent/runs.ts");
const { makeCtx } = await import("./helpers/agentCtx.ts");

const U = "00000000-0000-0000-0000-0000000000f1";
let run: Awaited<ReturnType<typeof makeDb>>["run"];
before(async () => {
  const ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, U);
});

const post = { connectionId: "x1", text: "Open house Saturday 10 to 2", link: null, sponsored: false, mediaRefs: [] };

test("a proposal waiting for approval is still there after a restart, and its approval still works", async () => {
  const before = new ActionStore(undefined, sqlProposalSink(run));
  const p = before.propose({ userId: U, kind: "social.post", payload: post, summary: "Open house", tainted: false, ctx: makeCtx() });
  const waiting = before.propose({ userId: U, kind: "social.post", payload: { ...post, text: "Second post" }, summary: "Second", tainted: false, ctx: makeCtx() });
  const { token } = before.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  await before.flush();

  // The server restarts: a new store, filled from the database.
  const sink = sqlProposalSink(run);
  const after = new ActionStore(undefined, sink);
  after.restore(await sink.load());
  assert.equal(after.get(waiting.id, U).status, "pending");
  assert.equal(after.get(p.id, U).status, "approved");

  let ran = 0;
  const done = await after.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: async () => { ran++; return { ok: true, detail: "Posted" }; } });
  assert.equal(done.status, "executed");
  assert.equal(ran, 1);
  await after.flush();
});

test("something being carried out when the server stopped is marked failed, never run twice", async () => {
  const before = new ActionStore(undefined, sqlProposalSink(run));
  const p = before.propose({ userId: U, kind: "social.post", payload: { ...post, text: "Mid-flight" }, summary: "Mid", tainted: false, ctx: makeCtx() });
  const { token } = before.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  // The post starts and the server stops before it finishes.
  void before.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: () => new Promise(() => {}) });
  await before.flush();

  const sink = sqlProposalSink(run);
  const after = new ActionStore(undefined, sink);
  after.restore(await sink.load());
  const restored = after.get(p.id, U);
  assert.equal(restored.status, "failed");
  assert.match(restored.result!.detail, /restarted/);
  await assert.rejects(after.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: async () => ({ ok: true, detail: "" }) }), { code: "not_approved" });
});

test("deleting the account removes saved proposals too", async () => {
  const store = new ActionStore(undefined, sqlProposalSink(run));
  store.propose({ userId: U, kind: "social.post", payload: { ...post, text: "To delete" }, summary: "Del", tainted: false, ctx: makeCtx() });
  await store.flush();
  store.forget(U);
  await new Promise((r) => setTimeout(r, 50));
  const { rows } = await run(`select count(*)::int as n from agent_proposals where user_id = $1`, [U]);
  assert.equal(rows[0].n, 0);
});

test("a finished run's answer can be collected after a restart; a running one says so", async () => {
  const jobs = new RunJobs((e) => ({ status: 500, message: String(e) }), undefined, undefined, sqlRunSink(run));
  let finish!: (v: unknown) => void;
  const id = jobs.start(U, () => new Promise((r) => { finish = r; }));
  await new Promise((r) => setTimeout(r, 50));

  const otherServer = new RunJobs((e) => ({ status: 500, message: String(e) }), undefined, undefined, sqlRunSink(run));
  assert.deepEqual(await otherServer.find(U, id), { status: "running" }, "during a deploy, the new server knows it's still going");

  finish({ text: "Your site is ready" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await otherServer.find(U, id), { status: "finished", result: { text: "Your site is ready" } });
  assert.equal(await otherServer.find("00000000-0000-0000-0000-000000000000", id), null, "only the person's own");
});

test("stopping waits for runs in flight and takes no new ones", async () => {
  let now = 0;
  const jobs = new RunJobs((e) => ({ status: 500, message: String(e) }), () => now);
  let finish!: (v: unknown) => void;
  jobs.start(U, () => new Promise((r) => { finish = r; }));
  let ticks = 0;
  const drained = jobs.drain(60_000, async () => { ticks++; now += 1000; if (ticks === 3) finish("done"); await Promise.resolve(); });
  assert.equal(jobs.draining, true);
  await drained;
  assert.equal(jobs.inFlight, 0);
  assert.ok(ticks >= 3);
});
