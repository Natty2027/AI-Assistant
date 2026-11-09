/**
 * Launch Kit: one request, and Hera makes the website page, posts, calendar entries and an
 * email ready to approve, all in one run. Real SQL (PGlite), fake Netlify and Bluesky, and a
 * scripted model. Nothing is published, posted, sent or changed until the person approves.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MASTER_KEY = Buffer.alloc(32, 14).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { AgentService } = await import("../server/agent/service.ts");
const { AGENT_MODEL } = await import("../server/agent/loop.ts");
import type { FetchLike } from "../server/shared.ts";

const U = "00000000-0000-0000-0000-0000000000a9";
let run: Awaited<ReturnType<typeof makeDb>>["run"];
let dir: string;
before(async () => {
  const ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, U);
  dir = await mkdtemp(path.join(tmpdir(), "hera-launch-"));
});

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const msg = (content: any[], stop_reason = "tool_use") =>
  ({ id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content, stop_reason, usage: { input_tokens: 10, output_tokens: 10 } }) as any;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

/** Netlify and Bluesky, faked: enough to connect both and nothing more. Publishing is never called. */
let published = 0;
const providers: FetchLike = async (url) => {
  const u = String(url);
  if (u.includes("api.netlify.com/api/v1/user")) return json({ email: "owner@example.com" });
  if (u.includes("createSession")) return json({ did: "did:plc:a", handle: "clay.bsky.social", accessJwt: "j" });
  published++;
  return json({}, 500);
};

const SNAPSHOT = {
  now: "2026-11-09T09:00:00-08:00", time_zone: "America/Los_Angeles",
  events: [], reminders: [], calendars: [{ name: "Home", writable: true, is_default: true }],
};

function service(client: any) {
  return new AgentService({ run, fetch: providers, sitesDir: path.join(dir, "sites"), mediaDir: path.join(dir, "media"), client, sleep: async () => {} });
}

test("one request makes the whole launch ready: site, posts, calendar, reminders and email", async () => {
  const netlify = await service(null).connectNetlify(U, "nfp_" + "x".repeat(40));
  const bluesky = await service(null).connectBluesky(U, "clay.bsky.social", "abcd-efgh-ijkl-mnop");
  const calls: any[] = [];
  let draftId = "";
  const steps = [
    () => msg([
      use("w1", "write_site_file", { path: "index.html", contents: "<html><head><title>Clay Corner</title></head><body><h1>Pottery workshop</h1><p>Nov 20, 6 PM, $40, 8 spots. Email us to sign up.</p></body></html>" }),
      use("p1", "draft_post", { connection_id: bluesky.id, text: "Pottery workshop Nov 20, 6 PM. $40, 8 spots!", link: null, sponsored: false, attach_photo: false }),
      use("c1", "add_event", { title: "Pottery workshop", start: "2026-11-20T18:00:00-08:00", end: "2026-11-20T20:00:00-08:00", all_day: false, location: "Clay Corner", notes: null, calendar: null, summary: "Add the workshop" }),
      use("r1", "add_reminder", { title: "Share countdown post", due: "2026-11-17T09:00:00-08:00", notes: "3 days to go! Pottery workshop Nov 20.", list: null, summary: "Countdown post reminder" }),
      use("e1", "draft_email", { to: [], cc: [], subject: "Pottery workshop Nov 20", body: "Hi!\n\nJoin our pottery workshop on Nov 20 at 6 PM. $40, 8 spots.\n\nClay Corner" }),
    ]),
    (p: any) => {
      draftId = JSON.parse(p.messages.at(-1).content.find((r: any) => r.tool_use_id === "p1").content).draft_id;
      return msg([
        use("s1", "propose_site_deploy", { connection_id: netlify.id, summary: "Publish the workshop page" }),
        use("p2", "propose_post", { draft_id: draftId, summary: "Announce the workshop on Bluesky" }),
      ]);
    },
    () => msg([{ type: "text", text: "Your launch is ready: the page, a Bluesky post, the event, a countdown reminder and an email. Each waits for your approval." }], "end_turn"),
  ];
  const client = { beta: { messages: { create: async (p: any) => { calls.push(structuredClone(p)); return steps[Math.min(calls.length - 1, steps.length - 1)](p); } } } };

  const out = await service(client).run(U, "Launch my pottery workshop on Nov 20 at 6 PM, $40, 8 spots", { mode: "launch", schedule: SNAPSHOT });

  assert.equal(out.status, "done");
  assert.deepEqual(out.proposals.map((p) => p.kind).sort(), ["site.deploy", "social.post"]);
  assert.ok(out.proposals.every((p) => p.status === "pending"), "everything waits for approval");
  assert.deepEqual(out.scheduleChanges.map((c) => c.kind), ["add_event", "add_reminder"]);
  assert.equal(out.emailDrafts.length, 1);
  assert.equal(published, 0, "nothing was published or posted");

  // The launch prompt and every kind of tool were offered, with the calendar in view.
  const tools = calls[0].tools.map((t: any) => t.name);
  for (const t of ["write_site_file", "propose_site_deploy", "draft_post", "propose_post", "add_event", "add_reminder", "draft_email", "remember"]) {
    assert.ok(tools.includes(t), `${t} offered`);
  }
  assert.match(calls[0].system, /complete launch/);
  assert.match(calls[0].system, /America\/Los_Angeles/);
  await run(`delete from action_connections where user_id = $1`, [U]);
});

test("a launch without calendar access still runs and skips the calendar", async () => {
  const calls: any[] = [];
  const client = { beta: { messages: { create: async (p: any) => {
    calls.push(structuredClone(p));
    return calls.length === 1
      ? msg([use("c1", "add_event", { title: "x", start: "2026-11-20T18:00:00-08:00", end: "2026-11-20T19:00:00-08:00", all_day: false, location: null, notes: null, calendar: null, summary: "x" })])
      : msg([{ type: "text", text: "Done without the calendar." }], "end_turn");
  } } } };
  const out = await service(client).run(U, "Launch my sale", { mode: "launch" });
  assert.equal(out.status, "done");
  assert.match(calls[0].system, /calendar wasn't shared/);
  assert.equal(out.scheduleChanges.length, 0);
  assert.match(calls[1].messages.at(-1).content[0].content, /wasn't shared/);
});
