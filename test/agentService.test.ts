/**
 * The whole path, end to end, against real SQL (PGlite with the project schema), a fake Bluesky
 * and a scripted model: connect an account, draft, propose, approve, post.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { AgentService } = await import("../server/agent/service.ts");
const { AGENT_MODEL } = await import("../server/agent/loop.ts");
import type { FetchLike } from "../server/shared.ts";

const U = "00000000-0000-0000-0000-0000000000a1";
const OTHER = "00000000-0000-0000-0000-0000000000b2";

let run: Awaited<ReturnType<typeof makeDb>>["run"];
let sitesDir: string;
before(async () => {
  const ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, U);
  await addUser(ctx.db, OTHER);
  sitesDir = await mkdtemp(path.join(tmpdir(), "pcc-svc-"));
});

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const msg = (content: any[], stop_reason = "tool_use") =>
  ({ id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content, stop_reason, usage: { input_tokens: 10, output_tokens: 10 } }) as any;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

function service(f: FetchLike, client: any = null) {
  return new AgentService({ run, fetch: f, sitesDir, mediaDir: path.join(sitesDir, "..", "media"), client, sleep: async () => {} });
}

/* ---------------- social posts (Bluesky) ---------------- */

const APP_PW = "abcd-efgh-ijkl-mnop";

/** A fake Bluesky that records the posts it was sent. */
function bluesky(opts: { sessionStatus?: number; postStatus?: number } = {}) {
  const posts: any[] = [];
  const f: FetchLike = async (url, init) => {
    const method = new URL(String(url)).pathname.replace("/xrpc/", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (method === "com.atproto.server.createSession") {
      if (opts.sessionStatus) return json({ error: "AuthenticationRequired" }, opts.sessionStatus);
      if (body.password !== APP_PW) return json({ error: "AuthenticationRequired" }, 401);
      return json({ did: "did:plc:clay", handle: "claycorner.bsky.social", accessJwt: "jwt" });
    }
    if (method === "com.atproto.repo.createRecord") {
      if (opts.postStatus) return json({}, opts.postStatus);
      assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer jwt");
      posts.push(body);
      return json({ uri: `at://did:plc:clay/app.bsky.feed.post/3k${posts.length}`, cid: "c" });
    }
    return json({}, 404);
  };
  return { f, posts };
}

/** A scripted model that drafts one post for `connectionId` and proposes it. */
function poster(connectionId: string, text: string, link: string | null = null) {
  let step = 0;
  return { beta: { messages: { create: async (params: any) => {
    step++;
    if (step === 1) return msg([use("t1", "draft_post", { connection_id: connectionId, text, link, sponsored: false })]);
    if (step === 2) {
      const draftId = JSON.parse(params.messages.at(-1).content[0].content).draft_id;
      return msg([use("t2", "propose_post", { draft_id: draftId, summary: "Announce the class" })]);
    }
    return msg([{ type: "text", text: "Your post is ready to review." }], "end_turn");
  } } } };
}

test("connecting Bluesky refuses a main password and a wrong app password, and stores a good one encrypted", async () => {
  const fake = bluesky();
  const svc = service(fake.f);
  await assert.rejects(() => svc.connectBluesky(U, "claycorner.bsky.social", "my-real-password"), { code: "bad_token" });
  await assert.rejects(() => svc.connectBluesky(U, "claycorner.bsky.social", "zzzz-zzzz-zzzz-zzzz"), { code: "bad_token" });
  const conn = await svc.connectBluesky(U, "@ClayCorner.bsky.social", APP_PW);
  assert.equal(conn.platform, "bluesky");
  assert.equal(conn.label, "Bluesky (@claycorner.bsky.social)");
  const { rows } = await run(`select token_ct from action_connections where id = $1`, [conn.id]);
  assert.ok(!Buffer.from(rows[0].token_ct).toString("utf8").includes(APP_PW), "the app password is never stored readable");
  await svc.disconnect(U, conn.id);
});

test("an approved post is published to Bluesky once, with the link made clickable", async () => {
  const fake = bluesky();
  const conn = await service(fake.f).connectBluesky(U, "claycorner.bsky.social", APP_PW);
  const svc = service(fake.f, (poster(conn.id, "Beginner pottery, Saturdays at 10. Sign up:", "https://claycorner.example/")));
  const out = await svc.run(U, "announce my class on bluesky", { mode: "posts" });
  const p = out.proposals[0];
  assert.equal(p.status, "pending");
  assert.equal(fake.posts.length, 0, "nothing is posted before approval");

  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });
  const done = await svc.execute(U, p.id, token);
  assert.equal(done.status, "executed");
  assert.equal(done.result!.ref, "https://bsky.app/profile/claycorner.bsky.social/post/3k1");
  assert.equal(fake.posts.length, 1);
  const record = fake.posts[0].record;
  assert.equal(record.text, "Beginner pottery, Saturdays at 10. Sign up:\n\nhttps://claycorner.example/");
  const facet = record.facets[0];
  assert.equal(Buffer.from(record.text).subarray(facet.index.byteStart, facet.index.byteEnd).toString(), "https://claycorner.example/");

  // The same words again today, to the same account, are refused by the rules.
  const repeat = new AgentService({ run, fetch: fake.f, sitesDir, mediaDir: path.join(sitesDir, "..", "media"), store: svc.store, sleep: async () => {},
    client: poster(conn.id, "Beginner pottery, Saturdays at 10. Sign up:", "https://claycorner.example/") });
  const again = (await repeat.run(U, "again", { mode: "posts" })).proposals[0];
  assert.equal(again.status, "blocked");
  assert.ok(again.checks.some((c) => c.id === "repeat_post"));
  await run(`delete from action_connections where id = $1`, [conn.id]);
});

test("a Bluesky app password revoked since connecting marks the account as needing reconnection", async () => {
  const conn = await service(bluesky().f).connectBluesky(U, "claycorner.bsky.social", APP_PW);
  const svc = service(bluesky({ sessionStatus: 401 }).f, (poster(conn.id, "Open studio this Friday.")));
  const p = (await svc.run(U, "post", { mode: "posts" })).proposals[0];
  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });
  const out = await svc.execute(U, p.id, token);
  assert.equal(out.status, "failed");
  assert.match(out.result!.detail, /Reconnect/);
  assert.equal((await svc.connections(U)).length, 0);
  await run(`delete from action_connections where id = $1`, [conn.id]);
});

test("a post aimed at an account that is not connected cannot be carried out", async () => {
  const svc = service(bluesky().f);
  const ctx = await svc.context(U);
  const p = svc.store.propose({ userId: U, kind: "social.post", payload: { connectionId: "x1", text: "hi", link: null, sponsored: false, mediaRefs: [] },
    summary: "post", tainted: false, ctx: { ...ctx, connections: [{ id: "x1", kind: "social", platform: "x", label: "X" }] } });
  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });
  await assert.rejects(() => svc.execute(U, p.id, token), { code: "blocked_at_execution" });
});

test("one person cannot see or remove another person's connection", async () => {
  const svc = service(bluesky().f);
  const c = await svc.connectBluesky(U, "claycorner.bsky.social", APP_PW);
  assert.equal((await svc.connections(OTHER)).length, 0);
  await assert.rejects(() => svc.disconnect(OTHER, c.id), { code: "not_found" });
  await svc.disconnect(U, c.id);
  assert.equal((await run(`select count(*)::int n from action_connections where id = $1`, [c.id])).rows[0].n, 0, "disconnecting deletes the row, token and all");
});

test("an old website hosting connection is neither listed nor offered to Hera", async () => {
  const { rows } = await run(`insert into action_connections (user_id, kind, provider, label, token_ct, data_key_id)
    values ($1, 'hosting', 'netlify', 'Netlify (owner@example.com)', '\\x00', 'k') returning id`, [U]);
  const svc = service(bluesky().f);
  assert.deepEqual(await svc.connections(U), []);
  assert.deepEqual((await svc.context(U)).connections, []);
  await run(`delete from action_connections where id = $1`, [rows[0].id]);
});

test("only posts, listings and personal emails from Outlook can be carried out", async () => {
  const { EXECUTABLE } = await import("../server/agent/service.ts");
  assert.deepEqual([...EXECUTABLE].sort(), ["email.send", "marketplace.listing", "social.post"]);
});

test("without an AI key the assistant says so; everything else still works", async () => {
  const svc = service(bluesky().f, null);
  await assert.rejects(() => svc.run(U, "write a post", { mode: "posts" }), { code: "ai_unavailable" });
  assert.ok(Array.isArray(await svc.connections(U)));
});

test("each person gets their own owner id for photos", async () => {
  const svc = service(bluesky().f);
  assert.notEqual(svc.siteIdFor(U), svc.siteIdFor(OTHER));
  assert.match(svc.siteIdFor(U), /^u-[a-f0-9]{24}$/);
});

test("deleting an account removes that person's old website files and proposals, and no one else's", async () => {
  const svc = service(bluesky().f);
  const post = { connectionId: "x1", text: "hi", link: null, sponsored: false, mediaRefs: [] };
  for (const who of [U, OTHER]) {
    // A website Hera built before website building was removed.
    await mkdir(path.join(sitesDir, svc.siteIdFor(who)), { recursive: true });
    await writeFile(path.join(sitesDir, svc.siteIdFor(who), "index.html"), "<h1>Mine</h1>");
    svc.store.propose({ userId: who, kind: "social.post", payload: post, summary: "post", tainted: false, ctx: await svc.context(who) });
  }
  const mine = svc.store.list(U)[0];

  await svc.forget(U);

  await assert.rejects(access(path.join(sitesDir, svc.siteIdFor(U))), { code: "ENOENT" });
  assert.equal(svc.list(U).length, 0);
  assert.throws(() => svc.store.get(mine.id, U), { code: "not_found" });
  // The other person keeps everything.
  await access(path.join(sitesDir, svc.siteIdFor(OTHER), "index.html"));
  assert.equal(svc.list(OTHER).length, 1);
  // Forgetting twice is harmless (a retried deletion).
  await svc.forget(U);
});
