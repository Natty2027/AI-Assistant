/**
 * Talk streams its reply: the loop reports the words so far as the model writes them, the run
 * keeps them (partial_text), and a check with ?after= answers as soon as there's more. What was
 * streamed is exactly what ends up in the reply. Without streaming nothing changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, AGENT_MODEL } from "../server/agent/loop.ts";
import { ActionStore } from "../server/agent/approvals.ts";
import { RunJobs } from "../server/agent/runs.ts";
import { afterLength } from "../server/routes.ts";
import { makeCtx } from "./helpers/agentCtx.ts";

type Block = Record<string, unknown>;
const msg = (content: Block[], stop_reason = "tool_use") =>
  ({ id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content, stop_reason, usage: { input_tokens: 100, output_tokens: 50 } }) as any;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const say = (text: string) => ({ type: "text", text });

/** The events the SDK's stream would give for a message: thinking, then each block, text in
 *  small pieces. */
function eventsFor(message: any): any[] {
  const events: any[] = [{ type: "message_start", message: { ...message, content: [] } }];
  message.content.forEach((b: any, index: number) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < b.text.length; i += 4) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(i, i + 4) } });
    } else {
      events.push({ type: "content_block_start", index, content_block: b });
    }
    events.push({ type: "content_block_stop", index });
  });
  return events;
}

/** A scripted model that streams. `fail` makes an attempt break off partway, after some words. */
function scriptedStream(steps: Array<() => any>, opts: { failFirstAttemptAfter?: number } = {}) {
  let calls = 0;
  let failed = false;
  const creates: any[] = [];
  const client = { beta: { messages: {
    create: async (params: any) => { creates.push(params); return steps[Math.min(calls++, steps.length - 1)](); },
    stream: (_params: any) => {
      const listeners: Array<(e: any) => void> = [];
      const breakOff = opts.failFirstAttemptAfter !== undefined && !failed;
      const message = breakOff ? null : steps[Math.min(calls++, steps.length - 1)]();
      return {
        on(event: string, listener: (e: any) => void) { if (event === "streamEvent") listeners.push(listener); return this; },
        async finalMessage() {
          if (breakOff) {
            failed = true;
            const partial = eventsFor(msg([say("Lost words that never finish.")], "end_turn")).slice(0, opts.failFirstAttemptAfter);
            for (const e of partial) for (const l of listeners) l(e);
            throw Object.assign(new Error("overloaded"), { status: 529 });
          }
          for (const e of eventsFor(message)) { await Promise.resolve(); for (const l of listeners) l(e); }
          return message;
        },
      };
    },
  } } };
  return { client, creates };
}

const deps = (client: any, onText?: (s: string) => void) =>
  ({ mode: "talk", client, store: new ActionStore(), userId: "u1", context: () => makeCtx(), sleep: async () => {}, onText }) as any;

test("a streamed talk reply is reported as it's written, and the reply is the last thing reported", async () => {
  const { client, creates } = scriptedStream([() => msg([say("It's sunny today. Have a lovely walk!")], "end_turn")]);
  const seen: string[] = [];
  const out = await runAgent(deps(client, (s) => seen.push(s)), "What's the weather?");
  assert.equal(out.status, "done");
  assert.equal(out.text, "It's sunny today. Have a lovely walk!");
  assert.equal(creates.length, 0, "streamed, not created");
  assert.ok(seen.length > 3, "reported in pieces");
  assert.equal(seen.at(-1), out.text);
  // Each report grows the one before it.
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].startsWith(seen[i - 1]), `${seen[i - 1]} -> ${seen[i]}`);
  // The conversation keeps the answer once, as before.
  assert.deepEqual(out.state.messages.at(-1), { role: "assistant", content: out.text });
});

test("words before a tool call are streamed and kept in the reply, joined to what comes after", async () => {
  const { client } = scriptedStream([
    () => msg([say("Sure, I'll write that email."), use("t1", "draft_email", { to: [], cc: [], subject: "Hi", body: "Hello there", send_at: null, invite: null })]),
    () => msg([say("It's on your screen to check and send.")], "end_turn"),
  ]);
  const seen: string[] = [];
  const out = await runAgent(deps(client, (s) => seen.push(s)), "Write an email saying hello.");
  assert.equal(out.status, "done");
  assert.equal(out.emailDrafts.length, 1, "the tool still ran");
  assert.equal(out.text, "Sure, I'll write that email.\nIt's on your screen to check and send.");
  assert.equal(seen.at(-1), out.text);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].startsWith(seen[i - 1]));
  // Earlier words stay in their own turn: the saved answer is only the last step's.
  assert.deepEqual(out.state.messages.at(-1), { role: "assistant", content: "It's on your screen to check and send." });
});

test("two text blocks in one step are joined with a new line, exactly as the reply joins them", async () => {
  const { client } = scriptedStream([() => msg([say("First part."), say("Second part.")], "end_turn")]);
  const seen: string[] = [];
  const out = await runAgent(deps(client, (s) => seen.push(s)), "Hi");
  assert.equal(out.text, "First part.\nSecond part.");
  assert.equal(seen.at(-1), out.text);
});

test("an attempt that breaks off is tried again from nothing, and the reply is the retry's", async () => {
  const { client } = scriptedStream([() => msg([say("Here you go.")], "end_turn")], { failFirstAttemptAfter: 4 });
  const seen: string[] = [];
  const out = await runAgent(deps(client, (s) => seen.push(s)), "Hi");
  assert.equal(out.status, "done");
  assert.equal(out.text, "Here you go.");
  assert.ok(seen.some((s) => s.startsWith("Lost")), "the broken attempt's words were reported");
  assert.equal(seen.at(-1), "Here you go.");
});

test("without onText, talk answers exactly as before: created, not streamed, and only the last step's words", async () => {
  const { client, creates } = scriptedStream([
    () => msg([say("Sure, I'll write that email."), use("t1", "draft_email", { to: [], cc: [], subject: "Hi", body: "Hello there", send_at: null, invite: null })]),
    () => msg([say("It's on your screen.")], "end_turn"),
  ]);
  const out = await runAgent(deps(client), "Write an email saying hello.");
  assert.equal(creates.length, 2);
  assert.equal(out.text, "It's on your screen.");
});

test("a run keeps the reply so far, and a check with after wakes as soon as there's more", async () => {
  const jobs = new RunJobs((e) => ({ status: 500, message: String(e) }));
  let report!: (s: string) => void;
  let finish!: (v: unknown) => void;
  const id = jobs.start("u1", (r) => { report = r; return new Promise((res) => { finish = res; }); });
  assert.equal(jobs.partial("u1", id), "");
  assert.equal(jobs.partial("someone-else", id), null);

  // Nothing new yet: a check waits.
  let started = Date.now();
  setTimeout(() => report("Hello"), 30);
  await jobs.wait("u1", id, 5_000, 0);
  assert.ok(Date.now() - started < 1_000, "woke on new words");
  assert.equal(jobs.partial("u1", id), "Hello");

  // The app has more than nothing: a check with after=0 answers at once.
  started = Date.now();
  await jobs.wait("u1", id, 5_000, 0);
  assert.ok(Date.now() - started < 50);

  // Reporting the same words again isn't news; the check waits out its time.
  started = Date.now();
  setTimeout(() => report("Hello"), 5);
  await jobs.wait("u1", id, 60, 5);
  assert.ok(Date.now() - started >= 55, "same words don't wake it");

  // Finishing wakes it too, and the words so far are gone with the run.
  setTimeout(() => finish({ text: "Hello there." }), 20);
  await jobs.wait("u1", id, 5_000, 5);
  assert.deepEqual(jobs.get("u1", id), { status: "finished", result: { text: "Hello there." } });
  assert.equal(jobs.partial("u1", id), null);
  report("too late");
  assert.equal(jobs.partial("u1", id), null);
});

test("without after, a check waits for the finished run only, as before", async () => {
  const jobs = new RunJobs((e) => ({ status: 500, message: String(e) }));
  let report!: (s: string) => void;
  const id = jobs.start("u1", (r) => { report = r; return new Promise(() => {}); });
  const started = Date.now();
  setTimeout(() => report("Hello"), 5);
  await jobs.wait("u1", id, 60);
  assert.ok(Date.now() - started >= 55, "words alone don't end an old-style wait");
});

test("after must be a whole number of characters; anything else means the old behaviour", () => {
  assert.equal(afterLength(null), null);
  assert.equal(afterLength(""), null);
  assert.equal(afterLength("abc"), null);
  assert.equal(afterLength("-1"), null);
  assert.equal(afterLength("2.5"), null);
  assert.equal(afterLength("0"), 0);
  assert.equal(afterLength("42"), 42);
});

test("a start sent again with the same client key gets the run already going, not a second one", async () => {
  const jobs = new RunJobs((e) => ({ status: 500, message: String(e) }));
  const id = jobs.start("u1", () => new Promise(() => {}), "key-1");
  assert.equal(jobs.findByClientKey("u1", "key-1"), id);
  assert.equal(jobs.findByClientKey("u1", "key-2"), null);
  assert.equal(jobs.findByClientKey("someone-else", "key-1"), null, "only the person's own runs");
});

test("if streaming itself fails, the same step is asked for without streaming and the turn is still answered", async () => {
  const creates: any[] = [];
  const client = { beta: { messages: {
    create: async (params: any) => { creates.push(params); return msg([say("I'm doing well, thanks for asking!")], "end_turn"); },
    stream: () => ({
      on() { return this; },
      async finalMessage() { throw Object.assign(new Error("400 invalid_request_error"), { status: 400 }); },
    }),
  } } };
  const seen: string[] = [];
  const out = await runAgent(deps(client, (s) => seen.push(s)), "Hey Hera, how are you?");
  assert.equal(out.status, "done");
  assert.equal(out.text, "I'm doing well, thanks for asking!");
  assert.equal(creates.length, 1, "asked once the ordinary way");
  assert.equal(seen.at(-1), "I'm doing well, thanks for asking!");
});
