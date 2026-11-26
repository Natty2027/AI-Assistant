/**
 * Regression tests for the security review: each recreates an attack that used to work, or a
 * weakness that's now closed.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MASTER_KEY = Buffer.alloc(32, 15).toString("base64");
const { MediaStore, MAX_PHOTOS_PER_OWNER } = await import("../server/agent/media.ts");
const { publishPost } = await import("../server/agent/x.ts");
const { encryptToken, decryptToken, newDataKeyId } = await import("../server/crypto/envelope.ts");
const { ProviderError } = await import("../server/shared.ts");

let base: string;
before(async () => { base = await mkdtemp(path.join(tmpdir(), "hera-sec-")); });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");

test("photos: each person keeps at most a fixed number, and expired ones aren't served", async () => {
  const dir = path.join(base, "media");
  let now = Date.now();
  const store = new MediaStore(dir, () => now);
  const owner = "u-" + "c".repeat(24);
  const ids: string[] = [];
  for (let i = 0; i < MAX_PHOTOS_PER_OWNER + 5; i++) {
    ids.push(await store.save(owner, JPEG));
    await utimes(path.join(dir, `${ids.at(-1)}.jpg`), new Date(now / 1000 + i), new Date((now + i * 1000)));
  }
  const kept = (await Promise.all(ids.map((id) => store.owns(owner, id)))).filter(Boolean).length;
  assert.equal(kept, MAX_PHOTOS_PER_OWNER);
  assert.equal(await store.owns(owner, ids[0]), false, "the oldest went first");
  now += 8 * 24 * 3_600_000;
  assert.equal(await store.read(`${ids.at(-1)}.jpg`), null, "past its week, not served");
});

test("X refusing a post (403) is a rejection, not a lost connection", async () => {
  const f = async () => new Response("{}", { status: 403 });
  await assert.rejects(
    () => publishPost({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 1e6, username: "c" }, { text: "hi", link: null }, f),
    (e: unknown) => e instanceof ProviderError && e.kind === "rejected");
});

test("encrypted tokens: a shortened blob or tag is refused", () => {
  const keyId = newDataKeyId();
  const blob = encryptToken("secret", keyId);
  assert.equal(decryptToken(blob, keyId), "secret");
  assert.throws(() => decryptToken(blob.subarray(0, 20), keyId));
  // Keep the IV, cut the tag to 4 bytes: must not authenticate.
  assert.throws(() => decryptToken(Buffer.concat([blob.subarray(0, 16), blob.subarray(28)]), keyId));
});
