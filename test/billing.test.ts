/**
 * Hera Pro: purchases are trusted only when the App Store signed them, and the monthly limit on
 * requests. A real App Store signature can't be made in a test, so a throwaway chain made with
 * openssl stands in for Apple's (its root fingerprint passed in); with Apple's real fingerprint
 * the same purchase is refused.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createPrivateKey, sign, X509Certificate } from "node:crypto";

process.env.MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
const { makeDb, addUser } = await import("./helpers/db.ts");
const { Billing, verifyTransaction } = await import("../server/billing.ts");

const U = "00000000-0000-0000-0000-0000000000a7";
const OTHER = "00000000-0000-0000-0000-0000000000a8";
const CFG = { enforced: true, freeLimit: 2, proLimit: 5, bundleId: "com.natty2027.hera", productIds: ["com.natty2027.hera.pro.monthly"] };

let run: Awaited<ReturnType<typeof makeDb>>["run"];
let chain: string[];
let leafKey: ReturnType<typeof createPrivateKey>;
let rootSha: string;

before(async () => {
  const ctx = await makeDb();
  run = ctx.run;
  await addUser(ctx.db, U);
  await addUser(ctx.db, OTHER);
  // root -> intermediate -> leaf, EC P-256, like the App Store's.
  const d = await mkdtemp(path.join(tmpdir(), "hera-billing-"));
  const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: d, stdio: "pipe" });
  for (const n of ["root", "int", "leaf"]) ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${n}.key`);
  ossl("req", "-x509", "-new", "-key", "root.key", "-subj", "/CN=Test Root", "-days", "30", "-out", "root.pem",
    "-addext", "basicConstraints=critical,CA:true");
  for (const [n, issuer, ca] of [["int", "root", true], ["leaf", "int", false]] as const) {
    ossl("req", "-new", "-key", `${n}.key`, "-subj", `/CN=Test ${n}`, "-out", `${n}.csr`);
    await import("node:fs/promises").then((fs) => fs.writeFile(path.join(d, `${n}.ext`), `basicConstraints=critical,CA:${ca}\n`));
    ossl("x509", "-req", "-in", `${n}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`, "-CAcreateserial", "-days", "30", "-out", `${n}.pem`, "-extfile", `${n}.ext`);
  }
  const der = async (n: string) => new X509Certificate(await readFile(path.join(d, `${n}.pem`))).raw.toString("base64");
  chain = [await der("leaf"), await der("int"), await der("root")];
  rootSha = createHash("sha256").update(Buffer.from(chain[2], "base64")).digest("hex").toUpperCase();
  leafKey = createPrivateKey(await readFile(path.join(d, "leaf.key")));
});

function purchase(over: Record<string, unknown> = {}): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "ES256", x5c: chain });
  const payload = enc({
    bundleId: "com.natty2027.hera", productId: "com.natty2027.hera.pro.monthly", originalTransactionId: "2000000111",
    transactionId: "2000000999", expiresDate: Date.now() + 30 * 86_400_000, environment: "Sandbox", appAccountToken: U, ...over,
  });
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key: leafKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

const opts = () => ({ bundleId: CFG.bundleId, productIds: CFG.productIds, rootSha256: rootSha });

test("a purchase signed through the App Store's chain is accepted and read", () => {
  const tx = verifyTransaction(purchase(), opts());
  assert.equal(tx.active, true);
  assert.equal(tx.originalTransactionId, "2000000111");
  assert.equal(tx.appAccountToken, U);
});

test("anything not signed by Apple is refused", () => {
  // The same purchase against Apple's real root: our test root isn't Apple's.
  assert.throws(() => verifyTransaction(purchase(), { bundleId: CFG.bundleId, productIds: CFG.productIds }), { code: "bad_purchase" });
  // Tampered after signing.
  const [h, , s] = purchase().split(".");
  const forged = Buffer.from(JSON.stringify({ bundleId: "com.natty2027.hera", productId: "com.natty2027.hera.pro.monthly", expiresDate: Date.now() + 1e10 })).toString("base64url");
  assert.throws(() => verifyTransaction(`${h}.${forged}.${s}`, opts()), { code: "bad_purchase" });
  assert.throws(() => verifyTransaction("not.a.jws", opts()), { code: "bad_purchase" });
});

test("only our app and our products", () => {
  assert.throws(() => verifyTransaction(purchase({ bundleId: "com.other.app" }), opts()), { code: "not_ours" });
  assert.throws(() => verifyTransaction(purchase({ productId: "com.natty2027.hera.coins" }), opts()), { code: "not_ours" });
});

test("redeeming gives Pro, a refund takes it away, and a subscription belongs to one account", async () => {
  const b = new Billing(run, { ...CFG, rootSha256: rootSha });
  assert.equal((await b.status(U)).plan, "free");
  const pro = await b.redeem(U, purchase());
  assert.equal(pro.plan, "pro");
  assert.equal(pro.limit, 5);
  await assert.rejects(b.redeem(OTHER, purchase()), { code: "not_yours" }, "bought for another account");
  await assert.rejects(b.redeem(OTHER, purchase({ appAccountToken: undefined })), { code: "not_yours" }, "already claimed");
  assert.equal((await b.redeem(U, purchase({ revocationDate: Date.now() }))).plan, "free");
  // Without the test root, production's Billing trusts only Apple.
  await assert.rejects(new Billing(run, CFG).redeem(U, purchase()), { code: "bad_purchase" });
});

test("each request counts; the month's limit stops more only when limits are on", async () => {
  await run(`delete from agent_usage where user_id = $1`, [OTHER]);
  const on = new Billing(run, CFG);
  await on.useOne(OTHER);
  await on.useOne(OTHER);
  await assert.rejects(on.useOne(OTHER), (e: any) => e.code === "limit_reached" && /2 free requests/.test(e.message));
  const s = await on.status(OTHER);
  assert.equal(s.used, 2);
  assert.match(s.resetsAt, /-01T00:00:00/);

  const off = new Billing(run, { ...CFG, enforced: false });
  await off.useOne(OTHER);
  assert.equal((await off.status(OTHER)).used, 3, "still counted, never stopped");
});
