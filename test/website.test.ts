/**
 * The website, improved: photos on the site (stored and published as real bytes), quality
 * checks Hera fixes before publishing, the brand kit, room for a whole page per step, and runs
 * that keep going in the background instead of timing out on the phone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { brokenLinks, SiteSandbox } from "../server/agent/sandbox.ts";
import { publish } from "../server/agent/netlify.ts";
import { readBrand, runAgent } from "../server/agent/loop.ts";
import { RunJobs } from "../server/agent/runs.ts";
import { ActionStore } from "../server/agent/approvals.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function site() {
  return SiteSandbox.open(await mkdtemp(path.join(tmpdir(), "hera-web-")), "site-1");
}

test("photos are kept as their exact bytes and published as them", async () => {
  const s = await site();
  await s.writeBytes("images/shop.jpg", JPEG);
  await s.writeBytes("logo.png", PNG);
  assert.deepEqual(await s.readBytes("images/shop.jpg"), JPEG);

  const uploads: Array<{ url: string; body: Uint8Array }> = [];
  const files = (await s.publishable()).files;
  const fakeFetch = async (url: string, init: any = {}) => {
    const u = String(url);
    if (init.method === "PUT") uploads.push({ url: u, body: init.body });
    const json = u.endsWith("/sites") ? { id: "s1" }
      : u.endsWith("/deploys") ? { id: "d1", required: files.map((f) => createHash("sha1").update(f.contents).digest("hex")) }
      : { state: "ready", ssl_url: "https://shop.netlify.app" };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  await publish("token", files, null, { fetch: fakeFetch as any, sleep: async () => {} });
  const photo = uploads.find((u) => u.url.endsWith("images/shop.jpg"));
  assert.ok(photo);
  assert.deepEqual(Buffer.from(photo.body), JPEG);
});

test("pictures can't be written as text, and must be what their name says", async () => {
  const s = await site();
  await assert.rejects(s.write("photo.jpg", "not really a photo"), /add_photo_to_site|svg/);
  await assert.rejects(s.writeBytes("photo.png", JPEG), /isn't a png/);
  await assert.rejects(s.writeBytes("page.html", JPEG), /pictures must be/);
});

test("replacing a file doesn't count its old size against the site's limit", async () => {
  const s = await site();
  const big = "x".repeat(1_500_000);
  for (let i = 0; i < 6; i++) await s.write("index.html", big);  // 6 × 1.5 MB would pass 10 MB if counted twice
  assert.equal((await s.files()).length, 1);
});

test("quality problems are found so Hera can fix them; they don't block publishing", async () => {
  const s = await site();
  await s.write("index.html", '<html><head></head><body><img src="images/missing.jpg"><a href="about.html">About</a><a href="https://example.com">x</a><a href="mailto:a@b.co">mail</a><a href="#top">top</a></body></html>');
  const checks = await s.scan();
  const ids = checks.map((c) => c.id).sort();
  assert.deepEqual(ids, ["broken_link", "img_alt", "no_title", "no_viewport"]);
  assert.ok(checks.every((c) => c.level === "warn"));
  assert.match(checks.find((c) => c.id === "broken_link")!.message, /images\/missing\.jpg, about\.html/);
});

test("links to pages and folders that exist aren't reported", () => {
  const paths = new Set(["index.html", "about.html", "menu/index.html", "css/site.css"]);
  assert.deepEqual(brokenLinks("menu/index.html", '<a href="../about.html"></a><a href="/"></a><link href="../css/site.css"><a href="./">x</a><a href="../menu/">m</a>', paths), []);
  assert.deepEqual(brokenLinks("index.html", '<a href="about"></a><a href="contact.html?x=1"></a>', paths), ["contact.html?x=1"]);
});

test("the brand kit is read only when it's well formed", () => {
  assert.deepEqual(readBrand({ business_name: "  Clay   Corner ", primary_color: "#1f6f5c", accent_color: "#F2A541" }),
    { businessName: "Clay Corner", primaryColor: "#1F6F5C", accentColor: "#F2A541" });
  assert.equal(readBrand({ primary_color: "red", accent_color: "#F2A541" }), null);
  assert.equal(readBrand("nope"), null);
  assert.equal(readBrand({ primary_color: "#000000", accent_color: "#FFFFFF" })?.businessName, null);
});

test("a website run has room for a whole page per step, uses the brand, and can put the photo on the site", async () => {
  const s = await site();
  const calls: any[] = [];
  const options: any[] = [];
  const steps = [
    () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "add_photo_to_site", input: { path: "images/shop.jpg" } }], usage: {} }),
    () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Done." }], usage: {} }),
  ];
  const client = { beta: { messages: { create: async (p: any, o: any) => { calls.push(p); options.push(o); return steps[calls.length - 1]() as any; } } } };
  const out = await runAgent({
    mode: "site", client, store: new ActionStore(), sandbox: s, userId: "u1",
    context: () => ({ connections: [], lists: [], usage: {}, siteScans: {}, siteDigests: {} }) as any,
    photoId: "u-abc-123", photoBytes: async () => JPEG,
    brand: { businessName: "Clay Corner", primaryColor: "#1F6F5C", accentColor: "#F2A541" },
  }, "Make a website for my shop with this photo");
  assert.equal(out.status, "done");
  assert.equal(calls[0].max_tokens, 32_000);
  assert.ok(options[0].timeout >= 10 * 60_000, "a long step needs its own timeout, or the SDK refuses it");
  assert.match(calls[0].system, /main color #1F6F5C/);
  assert.match(calls[0].system, /attached a photo/);
  assert.deepEqual(await s.readBytes("images/shop.jpg"), JPEG);
});

test("adding a photo without one attached says so", async () => {
  const s = await site();
  const calls: any[] = [];
  const steps = [
    () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "add_photo_to_site", input: { path: "a.jpg" } }], usage: {} }),
    () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: {} }),
  ];
  const client = { beta: { messages: { create: async (p: any) => { calls.push(structuredClone(p)); return steps[calls.length - 1]() as any; } } } };
  await runAgent({ mode: "site", client, store: new ActionStore(), sandbox: s, userId: "u1",
    context: () => ({ connections: [], lists: [], usage: {}, siteScans: {}, siteDigests: {} }) as any }, "site");
  const result = calls[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /didn't attach a photo/);
});

test("background runs: one at a time per person, answers collected later, failures explained", async () => {
  let now = 0;
  const jobs = new RunJobs((e) => ({ status: 500, message: String((e as Error).message) }), () => now, 1000);
  let finish!: (v: unknown) => void;
  const id = jobs.start("u1", () => new Promise((r) => { finish = r; }));
  assert.equal(jobs.isRunning("u1"), true);
  assert.equal(jobs.isRunning("u2"), false);
  assert.deepEqual(jobs.get("u1", id), { status: "running" });
  assert.equal(jobs.get("u2", id), null, "another person can't see it");

  finish({ text: "Your site is ready" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(jobs.get("u1", id), { status: "finished", result: { text: "Your site is ready" } });
  assert.equal(jobs.isRunning("u1"), false);

  const failed = jobs.start("u1", async () => { throw new Error("boom"); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(jobs.get("u1", failed), { status: "failed", failure: { status: 500, message: "boom" } });

  now = 5000;  // past the keeping time
  assert.equal(jobs.get("u1", id), null);
});
