/**
 * The Claude retry wrapper (server/agent/aiRetry.ts), ported from Cognivate's withAiRetry and
 * its spec: what is retried, what fails fast, and how long it waits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AiTimeoutError, backoffDelayMs, isTransient, parseRetryAfterMs, withAiRetry } from "../server/agent/aiRetry.ts";

const err = (fields: Record<string, unknown>) => Object.assign(new Error("x"), fields);
const noSleep = { sleep: async () => {} };

test("a 429 and then success returns the result after one retry", async () => {
  let calls = 0;
  const out = await withAiRetry(async () => { if (++calls === 1) throw err({ status: 429 }); return "ok"; }, noSleep);
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("server errors and dropped connections are retried, up to three attempts in all", async () => {
  for (const fields of [{ status: 503 }, { status: 500 }, { code: "ECONNRESET" }, { name: "APIConnectionError" }]) {
    let calls = 0;
    await assert.rejects(withAiRetry(async () => { calls++; throw err(fields); }, noSleep));
    assert.equal(calls, 3, JSON.stringify(fields));
  }
});

test("bad requests, auth and quota failures fail fast", async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    await assert.rejects(withAiRetry(async () => { calls++; throw err({ status }); }, noSleep));
    assert.equal(calls, 1, String(status));
  }
});

test("our own timeout becomes AiTimeoutError and is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    withAiRetry((signal) => { calls++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(err({ name: "AbortError" })))); },
      { attemptTimeoutMs: 10, ...noSleep }),
    (e: unknown) => e instanceof AiTimeoutError && e.timeoutMs === 10);
  assert.equal(calls, 1);
  assert.equal(isTransient(new AiTimeoutError(5)), false);
});

test("Retry-After is honoured in seconds or as a date, and capped", () => {
  assert.equal(parseRetryAfterMs({ "retry-after": "2" }), 2000);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "1" })), 1000);
  assert.equal(parseRetryAfterMs({ "retry-after": "600" }), 8000);
  const now = Date.parse("2026-11-07T12:00:00Z");
  assert.equal(parseRetryAfterMs({ "retry-after": "Sat, 07 Nov 2026 12:00:03 GMT" }, now), 3000);
  assert.equal(parseRetryAfterMs({}), null);
});

test("backoff is 500ms then 1500ms plus jitter, unless the server set a wait", () => {
  assert.equal(backoffDelayMs(1, null, () => 0), 500);
  assert.equal(backoffDelayMs(2, null, () => 0), 1500);
  assert.ok(backoffDelayMs(1, null, () => 0.99) < 750);
  assert.equal(backoffDelayMs(1, 4000), 4000);
});

test("the wait before a retry uses the server's Retry-After", async () => {
  const waits: number[] = [];
  let calls = 0;
  await withAiRetry(async () => { if (++calls === 1) throw err({ status: 429, headers: { "retry-after": "3" } }); return 1; },
    { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [3000]);
});
