/**
 * Selling Hera: the home page links to the App Store (or TestFlight before launch), websites on the
 * free plan carry a "Built with Hera" link that doesn't change what the person approved, and the
 * owner's dashboard counts people at each step behind a password.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { adminAllowed, getHeraUrl, growth, growthPage, homePage, withBuiltWithHera } = await import("../server/marketing.ts");
const { SiteSandbox } = await import("../server/agent/sandbox.ts");

let run: Awaited<ReturnType<typeof makeDb>>["run"];
before(async () => {
  const ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, "00000000-0000-0000-0000-0000000000b1");
  await run(`insert into user_settings (user_id) values ('00000000-0000-0000-0000-0000000000b1') on conflict do nothing`, []);
});

test("the home page goes to the App Store with Safari's banner, or TestFlight before launch", () => {
  const live = homePage({ appStoreId: "6740001234" }, "help@hera.app");
  assert.match(live, /<meta name="apple-itunes-app" content="app-id=6740001234"/);
  assert.match(live, /href="https:\/\/apps\.apple\.com\/app\/id6740001234">Download on the App Store/);

  const beta = homePage({ testflightUrl: "https://testflight.apple.com/join/AbCd1234" }, "help@hera.app");
  assert.match(beta, /Try Hera on TestFlight/);
  assert.doesNotMatch(beta, /apple-itunes-app/);

  assert.match(homePage({}, "help@hera.app"), /Coming soon to the App Store/);
  assert.equal(getHeraUrl({ appStoreId: "not-a-number" }), null);
  assert.equal(getHeraUrl({ testflightUrl: "https://evil.example/join" }), null, "only real TestFlight links");
});

test("'Built with Hera' goes just before </body>", () => {
  const out = withBuiltWithHera("<html><body><h1>Shop</h1></body></html>", "https://hera.example/");
  assert.match(out, /<h1>Shop<\/h1><p[^>]*>Built with <a href="https:\/\/hera\.example\/"[^>]*>Hera<\/a><\/p>\n<\/body>/);
  assert.match(withBuiltWithHera("<h1>No body tag</h1>", "https://hera.example/"), /<h1>No body tag<\/h1>\n<p/);
});

test("the link is added at publish time and doesn't change the approved fingerprint", async () => {
  const s = await SiteSandbox.open(await mkdtemp(path.join(tmpdir(), "hera-mk-")), "site-1");
  await s.write("index.html", "<html><head><title>Shop</title></head><body><h1>Shop</h1></body></html>");
  await s.write("site.css", "body{}");
  const plain = await s.publishable();
  const badged = await s.publishable({ decorate: (h) => withBuiltWithHera(h, "https://hera.example/") });
  assert.equal(badged.digest, plain.digest);
  assert.match(String(badged.files.find((f) => f.path === "index.html")!.contents), /Built with/);
  assert.equal(String(badged.files.find((f) => f.path === "site.css")!.contents), "body{}");
});

test("the dashboard needs ADMIN_TOKEN as the password", () => {
  const token = "a-long-admin-token-for-the-owner-only";
  const basic = (pw: string) => `Basic ${Buffer.from(`owner:${pw}`).toString("base64")}`;
  assert.equal(adminAllowed(basic(token), token), true);
  assert.equal(adminAllowed(basic("wrong"), token), false);
  assert.equal(adminAllowed(undefined, token), false);
  assert.equal(adminAllowed(basic("short"), "short"), false, "a short token never works");
});

test("the dashboard counts each step, without personal data", async () => {
  const g = await growth(run);
  assert.ok(g.accounts >= 1);
  const page = growthPage(g);
  assert.match(page, /Accounts<\/td><td class="n">\d+/);
  assert.match(page, /noindex/);
  assert.doesNotMatch(page, /00000000-0000/, "no account ids");
});
