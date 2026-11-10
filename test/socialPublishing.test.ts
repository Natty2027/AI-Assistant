/**
 * Posting to X, a Facebook Page and Instagram, end to end against real SQL (PGlite), fake X and
 * Meta APIs and a scripted model: sign in through the platform, attach a photo, draft, approve,
 * post. Plus the pieces on their own: one-time sign-in state, the photo store, X's link counting.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { AgentService } = await import("../server/agent/service.ts");
const { AGENT_MODEL } = await import("../server/agent/loop.ts");
const { OAuthStates, pkceChallenge } = await import("../server/agent/oauth.ts");
const { MediaStore } = await import("../server/agent/media.ts");
const { postContentChecks } = await import("../server/agent/policy.ts");
import type { FetchLike } from "../server/shared.ts";

const U = "00000000-0000-0000-0000-0000000000c1";
const OTHER = "00000000-0000-0000-0000-0000000000d2";
const PUBLIC = "https://hera.example";
const X_CLIENT = { clientId: "x-id", clientSecret: "x-secret" };
const META_CLIENT = { clientId: "meta-id", clientSecret: "meta-secret" };
/** The smallest thing that passes as a JPEG: the FF D8 FF signature. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");

let run: Awaited<ReturnType<typeof makeDb>>["run"];
let dir: string;
before(async () => {
  const ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, U);
  await addUser(ctx.db, OTHER);
  dir = await mkdtemp(path.join(tmpdir(), "hera-social-"));
});

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const form = (init?: RequestInit) => new URLSearchParams(String(init?.body ?? ""));

/** A fake X: token exchange and refresh (with rotating refresh tokens), who-am-I, and posting. */
function fakeX(opts: { postStatus?: number } = {}) {
  const tweets: any[] = [];
  let refreshes = 0;
  const f: FetchLike = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === "/2/oauth2/token") {
      assert.equal((init!.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("x-id:x-secret").toString("base64")}`);
      const b = form(init);
      if (b.get("grant_type") === "authorization_code") {
        if (b.get("code") !== "good-code" || !b.get("code_verifier")) return json({ error: "invalid_request" }, 400);
        return json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 7200 });
      }
      if (b.get("grant_type") === "refresh_token") {
        refreshes++;
        if (b.get("refresh_token") !== `rt-${refreshes}`) return json({ error: "invalid_request" }, 400);
        return json({ access_token: `at-${refreshes + 1}`, refresh_token: `rt-${refreshes + 1}`, expires_in: 7200 });
      }
    }
    if (u.pathname === "/2/users/me") return json({ data: { id: "42", username: "claycorner" } });
    if (u.pathname === "/2/tweets") {
      if (opts.postStatus) return json({}, opts.postStatus);
      tweets.push({ auth: (init!.headers as Record<string, string>).Authorization, ...JSON.parse(String(init!.body)) });
      return json({ data: { id: `17${tweets.length}`, text: "..." } });
    }
    return json({}, 404);
  };
  return { f, tweets, refreshes: () => refreshes };
}

/** A fake Graph API with one Page, linked to one Instagram account. */
function fakeMeta(opts: { pages?: any[]; tokenError?: boolean } = {}) {
  const calls: Array<{ path: string; body: URLSearchParams }> = [];
  const f: FetchLike = async (url, init) => {
    const u = new URL(String(url));
    const p = u.pathname.replace("/v23.0", "");
    calls.push({ path: p, body: form(init) });
    if (p === "/oauth/access_token") {
      if (u.searchParams.get("grant_type") === "fb_exchange_token") return json({ access_token: "long-user" });
      if (u.searchParams.get("code") !== "good-code") return json({ error: { code: 100 } }, 400);
      return json({ access_token: "short-user" });
    }
    if (p === "/me/accounts") {
      assert.equal(u.searchParams.get("access_token"), "long-user");
      return json({ data: opts.pages ?? [{ id: "p1", name: "Clay Corner", access_token: "page-token", instagram_business_account: { id: "ig1", username: "claycorner" } }] });
    }
    if (opts.tokenError) return json({ error: { code: 190, message: "expired" } }, 400);
    if (p === "/p1/feed") return json({ id: "p1_100" });
    if (p === "/p1/photos") return json({ id: "ph1", post_id: "p1_101" });
    if (p === "/ig1/media") return json({ id: "c1" });
    if (p === "/c1") return json({ status_code: "FINISHED" });
    if (p === "/ig1/media_publish") return json({ id: "m1" });
    if (p === "/m1") return json({ permalink: "https://www.instagram.com/p/abc/" });
    return json({}, 404);
  };
  return { f, calls };
}

function fakes(...fs: FetchLike[]): FetchLike {
  return async (url, init) => {
    const host = new URL(String(url)).host;
    return fs[host.endsWith("x.com") ? 0 : 1](url, init);
  };
}

const msg = (content: any[], stop_reason = "tool_use") =>
  ({ id: "m", type: "message", role: "assistant", model: AGENT_MODEL, content, stop_reason, usage: { input_tokens: 10, output_tokens: 10 } }) as any;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

/** A scripted model that drafts one post for `connectionId` and proposes it. */
function poster(connectionId: string, text: string, opts: { link?: string | null; photo?: boolean } = {}) {
  let step = 0;
  return { beta: { messages: { create: async (params: any) => {
    step++;
    if (step === 1) return msg([use("t1", "draft_post", { connection_id: connectionId, text, link: opts.link ?? null, sponsored: false, attach_photo: opts.photo ?? false })]);
    if (step === 2) {
      const draftId = JSON.parse(params.messages.at(-1).content[0].content).draft_id;
      return msg([use("t2", "propose_post", { draft_id: draftId, summary: "Announce the class" })]);
    }
    return msg([{ type: "text", text: "Ready to review." }], "end_turn");
  } } } };
}

function service(f: FetchLike, client: any = null) {
  return new AgentService({
    run, fetch: f, sitesDir: path.join(dir, "sites"), mediaDir: path.join(dir, "media"), client, sleep: async () => {},
    oauth: { publicUrl: PUBLIC, x: X_CLIENT, meta: META_CLIENT },
  });
}

/** Runs the whole sign-in: the app gets the sign-in page, the platform calls back with `code`. */
/** Runs the whole sign-in: the app gets the sign-in page, the platform calls back with `code`,
 *  and the app (signed in as the same person) confirms it. */
async function signIn(svc: InstanceType<typeof AgentService>, provider: "x" | "meta", code = "good-code") {
  const authUrl = new URL(svc.beginOAuth(U, provider));
  const back = new URLSearchParams({ state: authUrl.searchParams.get("state")!, code });
  const next = new URL(await svc.finishOAuth(provider, back));
  const pending = next.searchParams.get("pending");
  const note = pending ? (await svc.confirmOAuth(U, pending)).note : null;
  return { authUrl, next, note };
}

async function approveAndPost(svc: InstanceType<typeof AgentService>, request: string, photoId?: string) {
  const out = await svc.run(U, request, { mode: "posts", photoId });
  const p = out.proposals[0];
  const { token } = svc.approve(U, p.id, { payloadHash: p.payloadHash });
  return svc.execute(U, p.id, token);
}

async function clearConnections() {
  await run(`delete from action_connections where user_id = $1`, [U]);
}

/* ---------------- sign-in ---------------- */

test("sign-in state is single use, tied to one provider, and expires", () => {
  let now = 0;
  const states = new OAuthStates(() => now);
  const a = states.begin(U, "x");
  assert.equal(a.challenge, pkceChallenge(a.verifier));
  assert.equal(states.finish(a.state, "meta"), null, "a state for X can't finish a Meta sign-in");
  assert.equal(states.finish(a.state, "x"), null, "and a refused attempt uses it up");

  const b = states.begin(U, "x");
  assert.deepEqual(states.finish(b.state, "x"), { userId: U, verifier: b.verifier });
  assert.equal(states.finish(b.state, "x"), null, "a replayed callback finds nothing");

  const c = states.begin(U, "meta");
  now += 11 * 60_000;
  assert.equal(states.finish(c.state, "meta"), null);
});

test("connecting X: PKCE sign-in, tokens stored encrypted, and the account appears", async () => {
  const x = fakeX();
  const svc = service(fakes(x.f, fakeMeta().f));
  const { authUrl, next } = await signIn(svc, "x");
  assert.equal(authUrl.origin + authUrl.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(authUrl.searchParams.get("redirect_uri"), `${PUBLIC}/oauth/callback/x`);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(next.href, /^hera:\/\/connected\?provider=x&status=ok&pending=[\w-]{32}$/);

  const conns = await svc.connections(U);
  assert.deepEqual(conns.map((c) => [c.provider, c.platform, c.label]), [["x", "x", "X (@claycorner)"]]);
  const { rows } = await run(`select token_ct from action_connections where provider = 'x'`);
  assert.ok(!Buffer.from(rows[0].token_ct).toString("utf8").includes("rt-1"), "tokens are never stored readable");

  // Signing in to the same account again replaces it rather than adding a second.
  await signIn(svc, "x");
  assert.equal((await svc.connections(U)).length, 1);
  await clearConnections();
});

test("a sign-in link sent to someone else can't attach their account to the sender's Hera", async () => {
  const svc = service(fakes(fakeX().f, fakeMeta().f));
  // The attacker (U) starts a sign-in and sends the link to a victim, who signs in at X.
  const authUrl = new URL(svc.beginOAuth(U, "x"));
  const next = new URL(await svc.finishOAuth("x", new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "good-code" })));
  assert.equal((await svc.connections(U)).length, 0, "nothing is saved by the callback itself");
  // The victim's own Hera (OTHER) receives the return link: the sign-in wasn't theirs.
  const pending = next.searchParams.get("pending")!;
  await assert.rejects(() => svc.confirmOAuth(OTHER, pending), { code: "not_found" });
  // And the id is single use, so the attacker can't confirm it afterwards either.
  await assert.rejects(() => svc.confirmOAuth(U, pending), { code: "not_found" });
  assert.equal((await svc.connections(U)).length, 0);
  assert.equal((await svc.connections(OTHER)).length, 0);
});

test("a cancelled, refused or replayed sign-in sends the app a message and stores nothing", async () => {
  const svc = service(fakes(fakeX().f, fakeMeta().f));
  const refused = (await signIn(svc, "x", "bad-code")).next;
  assert.equal(refused.searchParams.get("status"), "error");
  assert.match(refused.searchParams.get("message")!, /wasn't accepted/);

  const authUrl = new URL(svc.beginOAuth(U, "meta"));
  const cancelled = new URL(await svc.finishOAuth("meta", new URLSearchParams({ state: authUrl.searchParams.get("state")!, error: "access_denied" })));
  assert.match(cancelled.searchParams.get("message")!, /cancelled/);

  const replay = new URL(await svc.finishOAuth("meta", new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "good-code" })));
  assert.match(replay.searchParams.get("message")!, /expired/);
  assert.equal((await svc.connections(U)).length, 0);
});

test("connecting Meta adds the Page and its Instagram account; no Page explains what's needed", async () => {
  const svc = service(fakes(fakeX().f, fakeMeta().f));
  const { authUrl, next } = await signIn(svc, "meta");
  assert.equal(authUrl.host, "www.facebook.com");
  assert.equal(next.searchParams.get("status"), "ok");
  assert.deepEqual((await svc.connections(U)).map((c) => [c.platform, c.label]),
    [["facebook", "Facebook (Clay Corner)"], ["instagram", "Instagram (@claycorner)"]]);
  await clearConnections();

  const none = service(fakes(fakeX().f, fakeMeta({ pages: [] }).f));
  const failed = (await signIn(none, "meta")).next;
  assert.match(failed.searchParams.get("message")!, /No Facebook Page/);
});

test("a business-type Meta app signs in with its Facebook Login for Business configuration", () => {
  const svc = new AgentService({ run, fetch: fakeMeta().f, sitesDir: dir, mediaDir: dir, client: null,
    oauth: { publicUrl: PUBLIC, meta: META_CLIENT, metaConfigId: "1234567890" } });
  const url = new URL(svc.beginOAuth(U, "meta"));
  assert.equal(url.searchParams.get("config_id"), "1234567890");
  assert.equal(url.searchParams.get("scope"), null, "permissions come from the configuration");
  // Without one, the permissions are listed (classic Facebook Login).
  assert.match(new URL(service(fakeMeta().f).beginOAuth(U, "meta")).searchParams.get("scope")!, /instagram_content_publish/);
});

test("a Page with no Instagram business account linked connects Facebook only, and says why", async () => {
  const svc = service(fakes(fakeX().f, fakeMeta({ pages: [{ id: "p1", name: "Clay Corner", access_token: "page-token" }] }).f));
  const { next, note } = await signIn(svc, "meta");
  assert.equal(next.searchParams.get("status"), "ok");
  assert.match(note!, /no Instagram Business or Creator account is linked/);
  assert.deepEqual((await svc.connections(U)).map((c) => c.platform), ["facebook"]);
  await clearConnections();
});

test("sign-in isn't offered until the server has its public address and the developer app", () => {
  const bare = new AgentService({ run, fetch: fakeX().f, sitesDir: dir, mediaDir: dir, client: null, oauth: { x: X_CLIENT } });
  assert.deepEqual(bare.oauthAvailable(), { x: false, meta: false });
  assert.throws(() => bare.beginOAuth(U, "x"), { code: "provider_unavailable" });
  assert.deepEqual(service(fakeX().f).oauthAvailable(), { x: true, meta: true });
});

/* ---------------- posting ---------------- */

test("an approved post goes to X with its link, refreshing an expired token and keeping the new one", async () => {
  const x = fakeX();
  const svc0 = service(fakes(x.f, fakeMeta().f));
  await signIn(svc0, "x");
  const conn = (await svc0.connections(U))[0];
  // Make the stored access token look expired.
  const { rows } = await run(`select token_ct, data_key_id from action_connections where id = $1`, [conn.id]);
  const { decryptToken, encryptToken } = await import("../server/crypto/envelope.ts");
  const cred = JSON.parse(decryptToken(Buffer.from(rows[0].token_ct), rows[0].data_key_id));
  await run(`update action_connections set token_ct = $2 where id = $1`, [conn.id, encryptToken(JSON.stringify({ ...cred, expiresAt: 0 }), rows[0].data_key_id)]);

  const svc = service(fakes(x.f, fakeMeta().f), poster(conn.id, "Beginner pottery, Saturdays.", { link: "https://claycorner.example/" }));
  const done = await approveAndPost(svc, "announce on x");
  assert.equal(done.status, "executed");
  assert.equal(done.result!.ref, "https://x.com/claycorner/status/171");
  assert.deepEqual(x.tweets, [{ auth: "Bearer at-2", text: "Beginner pottery, Saturdays.\n\nhttps://claycorner.example/" }]);
  assert.equal(x.refreshes(), 1);

  // The rotated refresh token was saved: the next refresh uses rt-2 and succeeds.
  const after = await run(`select token_ct, data_key_id from action_connections where id = $1`, [conn.id]);
  assert.equal(JSON.parse(decryptToken(Buffer.from(after.rows[0].token_ct), after.rows[0].data_key_id)).refreshToken, "rt-2");
  await clearConnections();
});

test("an X connection the person revoked is marked for reconnecting", async () => {
  const svc0 = service(fakes(fakeX().f, fakeMeta().f));
  await signIn(svc0, "x");
  const conn = (await svc0.connections(U))[0];
  const svc = service(fakes(fakeX({ postStatus: 401 }).f, fakeMeta().f), poster(conn.id, "Open studio Friday."));
  const out = await approveAndPost(svc, "post");
  assert.equal(out.status, "failed");
  assert.match(out.result!.detail, /X no longer accepts this connection/);
  assert.equal((await svc.connections(U)).length, 0);
  await clearConnections();
});

test("Facebook: text and link to the Page feed, or a photo post when a photo is attached", async () => {
  const meta = fakeMeta();
  const svc0 = service(fakes(fakeX().f, meta.f));
  await signIn(svc0, "meta");
  const page = (await svc0.connections(U)).find((c) => c.platform === "facebook")!;

  const text = await approveAndPost(service(fakes(fakeX().f, meta.f), poster(page.id, "Kiln day!", { link: "https://claycorner.example/" })), "fb");
  assert.equal(text.result!.ref, "https://www.facebook.com/p1_100");
  const feed = meta.calls.find((c) => c.path === "/p1/feed")!.body;
  assert.equal(feed.get("message"), "Kiln day!");
  assert.equal(feed.get("link"), "https://claycorner.example/");
  assert.equal(feed.get("access_token"), "page-token");

  const svc = service(fakes(fakeX().f, meta.f), poster(page.id, "New mugs.", { photo: true }));
  const photoId = await svc.savePhoto(U, JPEG);
  const withPhoto = await approveAndPost(svc, "fb photo", photoId);
  assert.equal(withPhoto.result!.ref, "https://www.facebook.com/p1_101");
  assert.equal(meta.calls.find((c) => c.path === "/p1/photos")!.body.get("url"), `${PUBLIC}/media/${photoId}.jpg`);
  await clearConnections();
});

test("Instagram: the attached photo is published with its caption; without one the post is refused", async () => {
  const meta = fakeMeta();
  const svc0 = service(fakes(fakeX().f, meta.f));
  await signIn(svc0, "meta");
  const ig = (await svc0.connections(U)).find((c) => c.platform === "instagram")!;

  const svc = service(fakes(fakeX().f, meta.f), poster(ig.id, "Fresh from the kiln. Link in bio.", { photo: true }));
  const photoId = await svc.savePhoto(U, JPEG);
  const done = await approveAndPost(svc, "ig", photoId);
  assert.equal(done.status, "executed");
  assert.equal(done.result!.ref, "https://www.instagram.com/p/abc/");
  const media = meta.calls.find((c) => c.path === "/ig1/media")!.body;
  assert.equal(media.get("image_url"), `${PUBLIC}/media/${photoId}.jpg`);
  assert.equal(media.get("caption"), "Fresh from the kiln. Link in bio.");
  assert.equal(meta.calls.find((c) => c.path === "/ig1/media_publish")!.body.get("creation_id"), "c1");

  // No photo: the rules block it before the person is even asked.
  const bare = service(fakes(fakeX().f, meta.f), poster(ig.id, "No photo here."));
  const p = (await bare.run(U, "ig", { mode: "posts" })).proposals[0];
  assert.equal(p.status, "blocked");
  assert.ok(p.checks.some((c) => c.id === "needs_media"));
  await clearConnections();
});

test("an expired Meta token marks only that connection for reconnecting", async () => {
  const svc0 = service(fakes(fakeX().f, fakeMeta().f));
  await signIn(svc0, "meta");
  const page = (await svc0.connections(U)).find((c) => c.platform === "facebook")!;
  const svc = service(fakes(fakeX().f, fakeMeta({ tokenError: true }).f), poster(page.id, "Hello."));
  const out = await approveAndPost(svc, "fb");
  assert.equal(out.status, "failed");
  assert.match(out.result!.detail, /Facebook no longer accepts this connection/);
  assert.deepEqual((await svc.connections(U)).map((c) => c.platform), ["instagram"]);
  await clearConnections();
});

/* ---------------- photos ---------------- */

test("photos: JPEG only, owned by one person, unguessable, and removed with their account", async () => {
  const svc = service(fakeX().f, poster("none", "hi"));
  await assert.rejects(() => svc.savePhoto(U, Buffer.from("<svg/>").toString("base64")), { code: "bad_media" });
  const mine = await svc.savePhoto(U, JPEG);
  assert.match(mine, new RegExp(`^${svc.siteIdFor(U)}-[a-f0-9]{32}$`));
  assert.ok(await svc.media.read(`${mine}.jpg`));
  assert.equal(await svc.media.read("../../etc/passwd"), null);

  // Someone else's photo id can't be used in your run.
  const theirs = await svc.savePhoto(OTHER, JPEG);
  await assert.rejects(() => svc.run(U, "post", { mode: "posts", photoId: theirs }), { code: "bad_media" });

  await svc.forget(U);
  assert.equal(await svc.media.read(`${mine}.jpg`), null);
  assert.ok(await svc.media.read(`${theirs}.jpg`), "the other person's photo stays");
});

test("photos older than a week are cleared out", async () => {
  let now = Date.now();
  const store = new MediaStore(path.join(dir, "old-media"), () => now);
  const id = await store.save("u-" + "a".repeat(24), JPEG);
  now += 8 * 24 * 3_600_000;
  await store.save("u-" + "b".repeat(24), JPEG);
  assert.equal(await store.read(`${id}.jpg`), null);
});

test("on X a link counts as 23 characters, however long it is", () => {
  const text = "a".repeat(250);
  const long = `https://claycorner.example/${"x".repeat(200)}`;
  assert.deepEqual(postContentChecks("x", text, long, false).filter((c) => c.id === "too_long"), []);
  assert.equal(postContentChecks("x", "a".repeat(260), long, false).some((c) => c.id === "too_long"), true);
});
