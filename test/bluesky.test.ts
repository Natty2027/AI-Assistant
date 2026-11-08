/**
 * The Bluesky connector on its own: credential parsing, the records it sends, and how the
 * character limit counts the appended link and emoji.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCredential, publishPost } from "../server/agent/bluesky.ts";
import { postContentChecks } from "../server/agent/policy.ts";
import type { FetchLike } from "../server/calendar.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

test("only an app password is accepted, never a main password", () => {
  assert.deepEqual(parseCredential(" @Me.bsky.social ", "ABCD-efgh-1234-mnop"), { identifier: "me.bsky.social", appPassword: "abcd-efgh-1234-mnop" });
  assert.throws(() => parseCredential("me.bsky.social", "hunter22"), /app password/);
  assert.throws(() => parseCredential("not a handle", "abcd-efgh-ijkl-mnop"), /handle/);
});

test("a link facet points at the link's UTF-8 bytes, even after emoji", async () => {
  let sent: any;
  const f: FetchLike = async (url, init) => {
    if (String(url).endsWith("createSession")) return json({ did: "did:plc:a", handle: "me.bsky.social", accessJwt: "j" });
    sent = JSON.parse(String(init!.body));
    return json({ uri: "at://did:plc:a/app.bsky.feed.post/abc" });
  };
  const out = await publishPost({ identifier: "me.bsky.social", appPassword: "abcd-efgh-ijkl-mnop" },
    { text: "Kiln day 🔥🔥 details:", link: "https://example.com/kiln" }, { fetch: f, now: new Date("2026-11-07T12:00:00Z") });
  assert.equal(out.url, "https://bsky.app/profile/me.bsky.social/post/abc");
  const r = sent.record;
  assert.equal(r.createdAt, "2026-11-07T12:00:00.000Z");
  const { byteStart, byteEnd } = r.facets[0].index;
  assert.equal(Buffer.from(r.text).subarray(byteStart, byteEnd).toString(), "https://example.com/kiln");
});

test("a wrong password is reported as unauthorized whether Bluesky answers 400 or 401", async () => {
  for (const status of [400, 401]) {
    const f: FetchLike = async () => json({ error: "AuthenticationRequired" }, status);
    await assert.rejects(() => publishPost({ identifier: "me.bsky.social", appPassword: "abcd-efgh-ijkl-mnop" }, { text: "hi", link: null }, { fetch: f }),
      (e: any) => e.kind === "unauthorized");
  }
});

test("Bluesky's 300 limit counts emoji as one and includes an appended link", () => {
  const emoji = "🌱".repeat(300); // 600 UTF-16 units, 300 graphemes
  assert.ok(!postContentChecks("bluesky", emoji, null, false).some((c) => c.id === "too_long"));
  assert.ok(postContentChecks("bluesky", "a".repeat(280), "https://example.com/a-long-path", false).some((c) => c.id === "too_long"));
  assert.ok(!postContentChecks("x", "a".repeat(280), null, false).some((c) => c.id === "too_long"));
});
