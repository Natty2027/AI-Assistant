/**
 * The single path from "proposed" to "done" (server/agent/approvals.ts). These are the
 * guarantees a user relies on when they let the assistant act for them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionStore, hashPayload, type Executor } from "../server/agent/approvals.ts";
import { makeCtx, post } from "./helpers/agentCtx.ts";

const U = "user-1";
let now = new Date("2026-11-10T15:00:00Z");
const clock = () => now;
const minutes = (m: number) => { now = new Date(now.getTime() + m * 60_000); };

function spyExecutor(result = { ok: true, ref: "post-123", detail: "posted" }) {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const run: Executor = async (kind, payload) => { calls.push({ kind, payload }); return result; };
  return { run, calls };
}

function fresh() {
  now = new Date("2026-11-10T15:00:00Z");
  return new ActionStore(clock);
}

const proposePost = (s: ActionStore, over = {}, extra: { tainted?: boolean; userId?: string } = {}) =>
  s.propose({ userId: extra.userId ?? U, kind: "social.post", payload: post(over), summary: "Class post", tainted: extra.tainted ?? false, ctx: makeCtx() });

test("propose -> approve -> execute runs the action exactly once and records each step", async () => {
  const s = fresh();
  const p = proposePost(s);
  assert.equal(p.status, "pending");
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  const ex = spyExecutor();
  const done = await s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: ex.run });
  assert.equal(done.status, "executed");
  assert.equal(ex.calls.length, 1);
  assert.deepEqual(s.auditLog(U).map((e) => e.event), ["proposed", "approved", "executed"]);
});

test("nothing happens without approval", async () => {
  const s = fresh();
  const p = proposePost(s);
  const ex = spyExecutor();
  await assert.rejects(() => s.execute({ id: p.id, userId: U, token: "guess", ctx: makeCtx(), executor: ex.run }), { code: "not_approved" });
  assert.equal(ex.calls.length, 0);
});

test("an approval token works once; a replay does nothing", async () => {
  const s = fresh();
  const p = proposePost(s);
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  const ex = spyExecutor();
  await s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: ex.run });
  await assert.rejects(() => s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: ex.run }), { code: "not_approved" });
  assert.equal(ex.calls.length, 1, "posted once, not twice");
});

test("two simultaneous executes with the same token run the action once", async () => {
  const s = fresh();
  const p = proposePost(s);
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  let calls = 0;
  const slow: Executor = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, detail: "ok" }; };
  const results = await Promise.allSettled([
    s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: slow }),
    s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: slow }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
});

test("a wrong token is refused, and the real one still works afterwards", async () => {
  const s = fresh();
  const p = proposePost(s);
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  const ex = spyExecutor();
  await assert.rejects(() => s.execute({ id: p.id, userId: U, token: token.slice(0, -1) + "x", ctx: makeCtx(), executor: ex.run }), { code: "bad_token" });
  assert.equal((await s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: ex.run })).status, "executed");
});

test("approving something other than what was proposed is refused", () => {
  const s = fresh();
  const p = proposePost(s);
  const other = hashPayload(post({ text: "Something else entirely" }));
  assert.throws(() => s.approve({ id: p.id, userId: U, payloadHash: other }), { code: "hash_mismatch" });
});

test("the stored payload cannot be changed after it is proposed", () => {
  const s = fresh();
  const input = post();
  const p = s.propose({ userId: U, kind: "social.post", payload: input, summary: "x", tainted: false, ctx: makeCtx() });
  input.text = "CHANGED after proposing";
  assert.notEqual(p.payload.text, "CHANGED after proposing", "the proposal kept its own copy");
  assert.throws(() => { (p.payload as any).text = "mutated"; }, TypeError, "and that copy is frozen");
  assert.equal(hashPayload(p.payload), p.payloadHash);
});

test("an approval expires after 15 minutes; a proposal after a day", async () => {
  const s = fresh();
  const p = proposePost(s);
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  minutes(16);
  await assert.rejects(() => s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: spyExecutor().run }), { code: "approval_expired" });

  const s2 = fresh();
  const q = proposePost(s2);
  minutes(25 * 60);
  assert.equal(s2.get(q.id, U).status, "expired");
  assert.throws(() => s2.approve({ id: q.id, userId: U, payloadHash: q.payloadHash }), { code: "not_pending" });
});

test("another user can neither see, approve nor execute it", async () => {
  const s = fresh();
  const p = proposePost(s);
  assert.throws(() => s.get(p.id, "intruder"), { code: "not_found" });
  assert.throws(() => s.approve({ id: p.id, userId: "intruder", payloadHash: p.payloadHash }), { code: "not_found" });
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  await assert.rejects(() => s.execute({ id: p.id, userId: "intruder", token, ctx: makeCtx(), executor: spyExecutor().run }), { code: "not_found" });
  assert.equal(s.list("intruder").length, 0);
});

test("a blocked proposal cannot be approved at all", () => {
  const s = fresh();
  const p = proposePost(s, { sponsored: true }); // no #ad
  assert.equal(p.status, "blocked");
  assert.throws(() => s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash }), { code: "not_pending" });
});

test("a testimonial needs that specific attestation; a generic OK is not enough", () => {
  const s = fresh();
  const p = proposePost(s, { text: '"Loved it!" - Maria' });
  assert.throws(() => s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash }), { code: "attestation_required" });
  assert.throws(() => s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash, attestations: ["claims"] }), { code: "attestation_required" });
  assert.ok(s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash, attestations: ["testimonial"] }).token);
});

test("a proposal shaped by outside content needs an explicit acknowledgement", () => {
  const s = fresh();
  const p = proposePost(s, {}, { tainted: true });
  assert.throws(() => s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash }), { code: "taint_ack_required" });
  assert.ok(s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash, acknowledgeTaint: true }).token);
});

test("spending requires the exact amount typed back", () => {
  const s = fresh();
  const ctx = makeCtx({ spendCapCents: 10_000 });
  const p = s.propose({ userId: U, kind: "ads.campaign", payload: { connectionId: "ads", budgetCents: 2500, text: "Pottery", link: "https://example.com" }, summary: "ad", tainted: false, ctx });
  assert.throws(() => s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash }), { code: "amount_required" });
  assert.throws(() => s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash, typedAmount: "$250.00" }), { code: "amount_required" });
  assert.ok(s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash, typedAmount: "$25.00" }).token);
});

test("rules are checked again at execution: a limit reached meanwhile stops it", async () => {
  const s = fresh();
  const p = proposePost(s);
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  const ex = spyExecutor();
  const atLimit = makeCtx({ usageToday: { "social.post:x1": 5 } });
  await assert.rejects(() => s.execute({ id: p.id, userId: U, token, ctx: atLimit, executor: ex.run }), { code: "blocked_at_execution" });
  assert.equal(ex.calls.length, 0);
  assert.equal(s.get(p.id, U).status, "blocked");
});

test("a failed execution is recorded, not retried, and leaks no provider error text", async () => {
  const s = fresh();
  const p = proposePost(s);
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  const boom: Executor = async () => { throw new Error("401 token=SECRET-abc123 for account ..."); };
  const out = await s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: boom });
  assert.equal(out.status, "failed");
  assert.doesNotMatch(JSON.stringify(s.auditLog(U)), /SECRET/);
  await assert.rejects(() => s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: spyExecutor().run }), { code: "not_approved" });
});

test("usage and spend are counted from what actually ran, not from what the caller says", async () => {
  const s = fresh();
  for (let i = 0; i < 2; i++) {
    const p = proposePost(s, { text: `Class number ${i}` });
    const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
    await s.execute({ id: p.id, userId: U, token, ctx: makeCtx(), executor: spyExecutor().run });
  }
  proposePost(s, { text: "Proposed but never approved" });
  const ctx = makeCtx({ spendCapCents: 10_000 });
  const ad = s.propose({ userId: U, kind: "ads.campaign", payload: { connectionId: "ads", budgetCents: 2500, text: "x", link: "https://example.com" }, summary: "ad", tainted: false, ctx });
  const { token } = s.approve({ id: ad.id, userId: U, payloadHash: ad.payloadHash, typedAmount: "$25.00" });
  await s.execute({ id: ad.id, userId: U, token, ctx, executor: spyExecutor().run });

  const u = s.usage(U);
  assert.equal(u.usageToday["social.post:x1"], 2);
  assert.equal(u.spentThisMonthCents, 2500);
  assert.deepEqual(s.usage("someone-else"), { usageToday: {}, spentThisMonthCents: 0 });
});

test("an unknown action kind cannot even be proposed", () => {
  const s = fresh();
  assert.throws(() => s.propose({ userId: U, kind: "social.dm", payload: {}, summary: "x", tainted: false, ctx: makeCtx() }), { code: "unknown_action" });
  assert.throws(() => s.propose({ userId: U, kind: "social.follow", payload: {}, summary: "x", tainted: false, ctx: makeCtx() }), { code: "unknown_action" });
});

test("the approval token never appears in the audit log", () => {
  const s = fresh();
  const p = proposePost(s);
  const { token } = s.approve({ id: p.id, userId: U, payloadHash: p.payloadHash });
  assert.doesNotMatch(JSON.stringify(s.auditLog(U)), new RegExp(token));
});
