/**
 * Sign-in tokens signed with Supabase's asymmetric keys, and the HTTP layer's request ids,
 * schema-drift answer, capped logs and public pages.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";

process.env.SUPABASE_URL = "https://proj.supabase.co";
delete process.env.DEV_USER_ID;
const { requireAuth, setSigningKeys } = await import("../server/auth.ts");
const { Router, HttpError, loggable, sendHtml } = await import("../server/http.ts");
const { privacyPage } = await import("../server/pages.ts");

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
setSigningKeys([{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256" }]);

function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "ES256", kid: "k1", typ: "JWT" }) {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64url(sig)}`;
}
const ctxWith = (t: string) => ({ req: { headers: { authorization: `Bearer ${t}` }, socket: { remoteAddress: "10.0.0.1" } } }) as any;
const good = { sub: "11111111-1111-1111-1111-111111111111", aud: "authenticated", iss: "https://proj.supabase.co/auth/v1", exp: Math.floor(Date.now() / 1000) + 600 };

test("a session signed with the project's ES256 key is accepted", () => {
  assert.equal(requireAuth(ctxWith(token(good))), good.sub);
});

test("wrong audience, wrong issuer, expiry and a forged signature are all refused", () => {
  for (const claims of [{ ...good, aud: "anon" }, { ...good, iss: "https://evil.example/auth/v1" }, { ...good, exp: 1 }]) {
    assert.throws(() => requireAuth(ctxWith(token(claims))), (e: any) => e.status === 401);
  }
  const forged = token(good).replace(/\.[^.]+$/, `.${b64url(Buffer.alloc(64, 1))}`);
  assert.throws(() => requireAuth(ctxWith(forged)), /signature/);
});

test("an unknown key id and alg:none are refused", () => {
  assert.throws(() => requireAuth(ctxWith(token(good, { alg: "ES256", kid: "unknown" }))), /not recognised/);
  const none = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(good))}.`;
  assert.throws(() => requireAuth(ctxWith(none)), (e: any) => e.status === 401);
});

/* ---------------- HTTP layer ---------------- */

const router = new Router()
  .get("/boom", () => { throw new Error("x".repeat(5000)); })
  .get("/drift", () => { throw Object.assign(new Error("column does not exist"), { code: "42703" }); })
  .get("/known", () => { throw new HttpError(409, "Already done"); })
  .get("/page", (ctx) => sendHtml(ctx.res, privacyPage("help@example.com")));
const server = createServer((req, res) => void router.handle(req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
after(() => server.close());

test("an unexpected error returns a request id the person can quote, never the internal message", async () => {
  const res = await fetch(`${base}/boom`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.requestId, /^[0-9a-f]{8}$/);
  assert.equal(res.headers.get("x-request-id"), body.requestId);
  assert.ok(!JSON.stringify(body).includes("xxxx"));
});

test("a database behind the code answers 503 schema_drift, not a generic 500", async () => {
  const res = await fetch(`${base}/drift`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "schema_drift");
});

test("known errors keep their status and message", async () => {
  const res = await fetch(`${base}/known`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "Already done");
});

test("long log messages are capped so the cause isn't cut off by the log pipe", () => {
  const out = loggable("y".repeat(10_000));
  assert.ok(out.length < 600);
  assert.match(out, /\[10000 chars\]$/);
  assert.equal(loggable("short"), "short");
});

test("public pages are HTML under a CSP that allows nothing to load or run", async () => {
  const res = await fetch(`${base}/page`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const html = await res.text();
  assert.match(html, /Anthropic/);
  assert.match(html, /help@example\.com/);
});

/* ---------------- the app's routes ---------------- */

const { buildRouter, checkMode, waitSeconds } = await import("../server/routes.ts");
const app = createServer((req, res) => void buildRouter().handle(req, res));
await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
const appBase = `http://127.0.0.1:${(app.address() as any).port}`;
after(() => app.close());
const signedIn = { Authorization: `Bearer ${token(good)}`, "Content-Type": "application/json" };

test("an app that still asks for a website is told to update, with its own code", async () => {
  for (const path of ["/agent/run", "/agent/runs"]) {
    const res = await fetch(`${appBase}${path}`, { method: "POST", headers: signedIn, body: JSON.stringify({ request: "Make me a website", mode: "site" }) });
    assert.equal(res.status, 410, path);
    const body = await res.json();
    assert.equal(body.code, "mode_removed");
    assert.match(body.error, /Building websites was removed from Hera\. Update the app/);
  }
});

test("the website endpoints are gone", async () => {
  for (const [method, path] of [["POST", "/agent/connections/netlify"], ["GET", "/agent/site"], ["GET", "/agent/site/file?path=index.html"]]) {
    const res = await fetch(`${appBase}${path}`, { method, headers: signedIn, ...(method === "POST" ? { body: JSON.stringify({ token: "x".repeat(40) }) } : {}) });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

test("modes: none means posts, unknown ones are refused, and the old website mode answers 410", () => {
  assert.equal(checkMode(undefined), "posts");
  assert.equal(checkMode("schedule"), "schedule");
  assert.equal(checkMode("launch"), "launch");
  assert.throws(() => checkMode("site"), (e: any) => e.status === 410 && e.code === "mode_removed" && e.expose === true);
  assert.throws(() => checkMode("blog"), (e: any) => e.status === 400 && /'posts', 'schedule' or 'launch'/.test(e.message));
});

test("?wait= is whole seconds from 0 to 25; anything else means don't wait", () => {
  assert.equal(waitSeconds(null), 0);
  assert.equal(waitSeconds("10"), 10);
  assert.equal(waitSeconds("2.7"), 2);
  assert.equal(waitSeconds("600"), 25);
  assert.equal(waitSeconds("-3"), 0);
  assert.equal(waitSeconds("soon"), 0);
  assert.equal(waitSeconds(""), 0);
});

test("checking a run this server doesn't have answers at once, even when asked to wait", async () => {
  const started = Date.now();
  const res = await fetch(`${appBase}/agent/runs/00000000-0000-0000-0000-00000000beef?wait=20`, { headers: signedIn });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "run_lost");
  assert.ok(Date.now() - started < 2_000);
});
