/**
 * The whole path, end to end, against real SQL (PGlite with the project schema), a fake Netlify
 * and a scripted model: connect hosting, build a site, propose, approve, publish.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { AgentService } = await import("../server/agent/service.ts");
const { AGENT_MODEL } = await import("../server/agent/loop.ts");
import type { FetchLike } from "../server/calendar.ts";

const U = "00000000-0000-0000-0000-0000000000a1";
const OTHER = "00000000-0000-0000-0000-0000000000b2";
const TOKEN = "nfp_" + "x".repeat(40);

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

/** A fake Netlify that records what was uploaded. */
function netlify(opts: { userStatus?: number; deployStatus?: number } = {}) {
  const uploads = new Map<string, string>();
  let deploys = 0;
  const f: FetchLike = async (url, init) => {
    const p = new URL(String(url)).pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    if (p === "/user") return opts.userStatus ? json({}, opts.userStatus) : json({ email: "owner@example.com" });
    if (method === "POST" && p === "/sites") return json({ id: "site-1", ssl_url: "https://clay-corner.netlify.app" });
    if (method === "GET" && p === "/sites/site-1") return json({ id: "site-1", ssl_url: "https://clay-corner.netlify.app" });
    if (method === "POST" && p === "/sites/site-1/deploys") {
      if (opts.deployStatus) return json({}, opts.deployStatus);
      deploys++;
      return json({ id: "dep-1", required: Object.values(JSON.parse(String(init!.body)).files) });
    }
    if (method === "PUT" && p.startsWith("/deploys/dep-1/files/")) {
      uploads.set(decodeURIComponent(p.slice("/deploys/dep-1/files/".length)), Buffer.from(init!.body as Buffer).toString("utf8"));
      return json({});
    }
    if (method === "GET" && p === "/sites/site-1/deploys/dep-1") return json({ state: "ready", ssl_url: "https://clay-corner.netlify.app" });
    return json({}, 404);
  };
  return { f, uploads, deploys: () => deploys };
}

const msg = (content: any[], stop_reason = "tool_use") =>
  ({ id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content, stop_reason, usage: { input_tokens: 10, output_tokens: 10 } }) as any;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

/** A scripted model that builds a one-page site and proposes publishing it to `connectionId`. */
function siteBuilder(connectionId: string, html = "<h1>Clay Corner</h1><p>Pottery for beginners, Saturdays.</p>") {
  let step = 0;
  return { beta: { messages: { create: async () => {
    step++;
    if (step === 1) return msg([use("t1", "write_site_file", { path: "index.html", contents: `<html><head><title>Clay Corner</title></head><body>${html}</body></html>` })]);
    if (step === 2) return msg([use("t2", "propose_site_deploy", { connection_id: connectionId, summary: "Publish the Clay Corner website" })]);
    return msg([{ type: "text", text: "Your site is ready for you to review and publish." }], "end_turn");
  } } } };
}

function service(f: FetchLike, client: any = null) {
  return new AgentService({ run, fetch: f, sitesDir, client, sleep: async () => {} });
}

/* ---------------- connections ---------------- */

test("connecting Netlify checks the token first and stores it encrypted, never readable back", async () => {
  const svc = service(netlify().f);
  const c = await svc.connectNetlify(U, TOKEN);
  assert.equal(c.label, "Netlify (owner@example.com)");
  const row = (await run(`select token_ct from action_connections where id = $1`, [c.id])).rows[0];
  assert.ok(!Buffer.from(row.token_ct).toString("utf8").includes(TOKEN), "the database holds ciphertext, not the token");
  const listed = await svc.connections(U);
  assert.ok(!JSON.stringify(listed).includes(TOKEN), "the token is never returned");
  await svc.disconnect(U, c.id);
});

test("a token Netlify rejects, or one that is obviously malformed, is not stored", async () => {
  await assert.rejects(() => service(netlify({ userStatus: 401 }).f).connectNetlify(U, TOKEN), { code: "bad_token" });
  await assert.rejects(() => service(netlify().f).connectNetlify(U, "short"), { code: "bad_token" });
  await assert.rejects(() => service(netlify().f).connectNetlify(U, "has spaces in it which tokens never do 1234"), { code: "bad_token" });
  assert.equal((await service(netlify().f).connections(U)).length, 0);
});

test("one person cannot see or remove another person's connection", async () => {
  const svc = service(netlify().f);
  const c = await svc.connectNetlify(U, TOKEN);
  assert.equal((await svc.connections(OTHER)).length, 0);
  await assert.rejects(() => svc.disconnect(OTHER, c.id), { code: "not_found" });
  await svc.disconnect(U, c.id);
  assert.equal((await run(`select count(*)::int n from action_connections where id = $1`, [c.id])).rows[0].n, 0, "disconnecting deletes the row, token and all");
});

/* ---------------- the full path ---------------- */

test("build -> propose -> approve -> publish: the approved site goes live on the person's Netlify", async () => {
  const fake = netlify();
  const conn = await service(fake.f).connectNetlify(U, TOKEN);
  const svc = service(fake.f, siteBuilder(conn.id));

  const out = await svc.run(U, "Make a one-page site for my pottery studio, Clay Corner.");
  assert.equal(out.status, "done");
  const p = out.proposals[0];
  assert.equal(p.kind, "site.deploy");
  assert.equal(p.status, "pending");
  assert.equal(fake.deploys(), 0, "nothing was published by the assistant");

  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });
  const done = await svc.execute(U, p.id, token);
  assert.equal(done.status, "executed");
  assert.equal(done.result?.ref, "https://clay-corner.netlify.app");
  assert.equal(fake.deploys(), 1);

  const page = fake.uploads.get("index.html")!;
  assert.match(page, /Clay Corner/);
  assert.match(page, /Content-Security-Policy/, "the published page carries the security policy");
  assert.equal((await run(`select target_ref from action_connections where id = $1`, [conn.id])).rows[0].target_ref, "site-1", "the site is remembered so the address stays the same");
  await svc.disconnect(U, conn.id);
});

test("if the site changes after approval, nothing is published", async () => {
  const fake = netlify();
  const conn = await service(fake.f).connectNetlify(U, TOKEN);
  const svc = service(fake.f, siteBuilder(conn.id, "<h1>Version one</h1>"));
  const p = (await svc.run(U, "build it")).proposals[0];
  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });

  await (await svc.sandbox(U)).write("index.html", "<h1>Something the person never saw</h1>");

  await assert.rejects(() => svc.execute(U, p.id, token), { code: "blocked_at_execution" });
  assert.equal(fake.deploys(), 0);
  await svc.disconnect(U, conn.id);
});

test("a site with a phishing-style password field cannot even be proposed for publishing", async () => {
  const fake = netlify();
  const conn = await service(fake.f).connectNetlify(U, TOKEN);
  const svc = service(fake.f, siteBuilder(conn.id, '<form><input type="password" name="pw"></form>'));
  const p = (await svc.run(U, "build a login page")).proposals[0];
  assert.equal(p.status, "blocked");
  assert.ok(p.checks.some((c) => c.id === "password_field"));
  assert.throws(() => svc.approve(U, p.id, { payloadHash: p.payloadHash }), { code: "not_pending" });
  await svc.disconnect(U, conn.id);
});

test("publishing to a connection that is not the person's is blocked", async () => {
  const fake = netlify();
  const theirs = await service(fake.f).connectNetlify(OTHER, TOKEN);
  const svc = service(fake.f, siteBuilder(theirs.id));
  const p = (await svc.run(U, "publish to that account")).proposals[0];
  assert.equal(p.status, "blocked");
  assert.ok(p.checks.some((c) => c.id === "unknown_destination"));
  await service(fake.f).disconnect(OTHER, theirs.id);
});

test("a social post can be drafted but not approved: there is no connection to carry it out yet", async () => {
  const svc = service(netlify().f);
  const ctx = await svc.context(U);
  const p = svc.store.propose({ userId: U, kind: "social.post", payload: { connectionId: "x1", text: "hi", link: null, sponsored: false, mediaRefs: [] },
    summary: "post", tainted: false, ctx: { ...ctx, connections: [{ id: "x1", kind: "social", platform: "x", label: "X" }] } });
  assert.throws(() => svc.approve(U, p.id, { payloadHash: p.payloadHash }), { code: "not_connected" });
});

test("a token Netlify has since revoked marks the connection as needing reconnection", async () => {
  const fake = netlify({ deployStatus: 401 });
  const conn = await service(netlify().f).connectNetlify(U, TOKEN);
  const svc = service(fake.f, siteBuilder(conn.id));
  const p = (await svc.run(U, "build")).proposals[0];
  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });
  const out = await svc.execute(U, p.id, token);
  assert.equal(out.status, "failed");
  assert.match(out.result!.detail, /Reconnect/);
  assert.equal((await svc.connections(U)).length, 0, "the dead connection is no longer offered");
  await run(`delete from action_connections where id = $1`, [conn.id]);
});

test("without an AI key the assistant says so; everything else still works", async () => {
  const svc = service(netlify().f, null);
  await assert.rejects(() => svc.run(U, "build"), { code: "ai_unavailable" });
  assert.ok(Array.isArray(await svc.connections(U)));
});

test("each person gets their own site folder", async () => {
  const svc = service(netlify().f);
  assert.notEqual(svc.siteIdFor(U), svc.siteIdFor(OTHER));
  assert.match(svc.siteIdFor(U), /^u-[a-f0-9]{24}$/);
});
