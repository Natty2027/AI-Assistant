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
