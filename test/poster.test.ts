/**
 * Posters: Hera writes the words and picks a style; the app draws it. The harness keeps posters
 * short and honest, and nothing is published.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent, AGENT_MODEL } from "../server/agent/loop.ts";
import { ActionStore } from "../server/agent/approvals.ts";
import { SiteSandbox } from "../server/agent/sandbox.ts";
import { makeCtx } from "./helpers/agentCtx.ts";

let base: string;
before(async () => { base = await mkdtemp(path.join(tmpdir(), "hera-poster-")); });
const msg = (content: any[], stop_reason = "tool_use") =>
  ({ id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content, stop_reason, usage: { input_tokens: 10, output_tokens: 10 } }) as any;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const poster = (over: Record<string, unknown> = {}) => ({
  style: "playful", headline: "Pottery Workshop", subheadline: "Make your own mug", details: ["Sat, Nov 20 · 6 PM", "Clay Corner, 12 Main St", "$40 · 8 spots"],
  call_to_action: "Book now", footer: "claycorner.example", emoji: "🏺✨", use_photo: false, ...over,
});

let n = 0;
async function run(mode: "posts" | "launch" | "site", steps: Array<() => any>, extra: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const client = { beta: { messages: { create: async (p: any) => { calls.push(structuredClone(p)); return steps[Math.min(calls.length - 1, steps.length - 1)](); } } } };
  const out = await runAgent({ mode, client, store: new ActionStore(), sandbox: await SiteSandbox.open(base, `s-${++n}`), userId: "u1", context: () => makeCtx(), ...extra } as any, "Make a poster for my workshop");
  return { out, calls, results: (i: number) => calls[i].messages.at(-1).content as any[] };
}
const done = () => msg([{ type: "text", text: "Here's your poster." }], "end_turn");

test("Studio designs a poster for the app to draw; nothing is published", async () => {
  const { out, calls } = await run("posts", [() => msg([use("d1", "design_poster", poster())]), done]);
  assert.equal(out.posterDrafts.length, 1);
  const p = out.posterDrafts[0];
  assert.equal(p.style, "playful");
  assert.equal(p.headline, "Pottery Workshop");
  assert.deepEqual(p.details, ["Sat, Nov 20 · 6 PM", "Clay Corner, 12 Main St", "$40 · 8 spots"]);
  assert.equal(p.callToAction, "Book now");
  assert.equal(out.proposalIds.length, 0);
  assert.ok(calls[0].tools.some((t: any) => t.name === "design_poster"));
  assert.match(calls[0].system, /design posters and flyers/);
});

test("posters stay short, honest and only use a photo that was attached", async () => {
  const { out, results } = await run("posts", [() => msg([
    use("a", "design_poster", poster({ headline: "x".repeat(61) })),
    use("b", "design_poster", poster({ details: ["1", "2", "3", "4", "5"] })),
    use("c", "design_poster", poster({ use_photo: true })),
    use("d", "design_poster", poster({ emoji: "go evil.co" })),
    use("e", "design_poster", poster({ subheadline: "Guaranteed to cure stress, 100% risk-free" })),
  ]), done]);
  const r = results(1);
  assert.equal(r[0].is_error, true, "headline too long");
  assert.equal(r[1].is_error, true, "too many detail lines");
  assert.match(r[2].content, /didn't attach a photo/);
  assert.match(r[3].content, /emoji only/);
  assert.equal(out.posterDrafts.length, 1, "the honest-claims one is made, with its concern attached");
  assert.ok(out.posterDrafts[0].problems.length > 0, JSON.stringify(out.posterDrafts[0]));
});

test("a launch includes a poster; the website mode can't design one", async () => {
  const launch = await run("launch", [() => msg([use("d1", "design_poster", poster({ style: "bold" }))]), done]);
  assert.equal(launch.out.posterDrafts.length, 1);
  assert.match(launch.calls[0].system, /Poster: design one poster/);
  const site = await run("site", [() => msg([use("d1", "design_poster", poster())]), done]);
  assert.equal(site.out.posterDrafts.length, 0);
  assert.match(site.results(1)[0].content, /switch to/);
});
