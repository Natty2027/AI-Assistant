/**
 * The deterministic rules every action must pass (server/agent/policy.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, isBlocked, type Check } from "../server/agent/policy.ts";
import { makeCtx, post } from "./helpers/agentCtx.ts";

const ids = (c: Check[]) => c.map((x) => x.id);
const level = (c: Check[], id: string) => c.find((x) => x.id === id)?.level;
const NOW = new Date("2026-11-10T15:00:00Z");

/* ---------------- destinations and shape ---------------- */

test("a plain, honest post passes", () => {
  assert.deepEqual(evaluate("social.post", post(), makeCtx(), NOW), []);
});

test("a destination that is not one of the user's connections is blocked", () => {
  assert.deepEqual(ids(evaluate("social.post", post({ connectionId: "attacker" }), makeCtx(), NOW)), ["unknown_destination"]);
});

test("a connection of the wrong kind is blocked (hosting account used for a post)", () => {
  assert.deepEqual(ids(evaluate("social.post", post({ connectionId: "host" }), makeCtx(), NOW)), ["unknown_destination"]);
});

test("an extra field smuggled into the payload is rejected, not ignored", () => {
  const c = evaluate("social.post", { ...post(), replyTo: "@victim" }, makeCtx(), NOW);
  assert.deepEqual(ids(c), ["invalid"]);
});

test("a non-https link is rejected", () => {
  assert.deepEqual(ids(evaluate("social.post", post({ link: "http://example.com" }), makeCtx(), NOW)), ["invalid"]);
  assert.deepEqual(ids(evaluate("social.post", post({ link: "javascript:alert(1)" }), makeCtx(), NOW)), ["invalid"]);
});

/* ---------------- platform rules ---------------- */

test("too long for X is blocked; Instagram needs media", () => {
  assert.ok(ids(evaluate("social.post", post({ text: "a".repeat(281) }), makeCtx(), NOW)).includes("too_long"));
  assert.ok(ids(evaluate("social.post", post({ connectionId: "ig" }), makeCtx(), NOW)).includes("needs_media"));
  assert.equal(isBlocked(evaluate("social.post", post({ connectionId: "ig", mediaRefs: ["img1"] }), makeCtx(), NOW)), false);
});

test("mass mentions are blocked as spam; one mention is only a warning", () => {
  assert.equal(level(evaluate("social.post", post({ text: "Thanks @a @b @c for coming!" }), makeCtx(), NOW), "mass_mentions"), "block");
  const one = evaluate("social.post", post({ text: "Thanks @studio_friend for hosting!" }), makeCtx(), NOW);
  assert.equal(level(one, "mentions"), "warn");
  assert.equal(isBlocked(one), false);
});

test("the same post to a second account this week is blocked", () => {
  const ctx = makeCtx({ recentPosts: [{ connectionId: "x1", text: "Beginner pottery class this Saturday at 10am. All materials included!", at: new Date(NOW.getTime() - 2 * 86_400_000) }] });
  assert.ok(ids(evaluate("social.post", post({ connectionId: "x2" }), ctx, NOW)).includes("duplicate_across_accounts"));
});

test("repeating a post on the same account within a day is blocked, but not after a week", () => {
  const recent = (ms: number) => makeCtx({ recentPosts: [{ connectionId: "x1", text: post().text as string, at: new Date(NOW.getTime() - ms) }] });
  assert.ok(ids(evaluate("social.post", post(), recent(3_600_000), NOW)).includes("repeat_post"));
  assert.equal(isBlocked(evaluate("social.post", post({ connectionId: "x2" }), recent(8 * 86_400_000), NOW)), false);
});

test("the daily limit per account is enforced", () => {
  const ctx = makeCtx({ usageToday: { "social.post:x1": 5 } });
  assert.ok(ids(evaluate("social.post", post(), ctx, NOW)).includes("daily_limit"));
  assert.equal(isBlocked(evaluate("social.post", post({ connectionId: "x2" }), ctx, NOW)), false, "a different account has its own allowance");
});

/* ---------------- honesty rules ---------------- */

test("sponsored content must be disclosed", () => {
  assert.ok(ids(evaluate("social.post", post({ sponsored: true }), makeCtx(), NOW)).includes("disclosure"));
  assert.equal(isBlocked(evaluate("social.post", post({ sponsored: true, text: "Pottery class Saturday #ad" }), makeCtx(), NOW)), false);
});

test("anything that looks like a review or testimonial needs the user's attestation", () => {
  for (const text of [
    '"Best class I have ever taken!" - Sarah K.',
    "Rated ★★★★★ by our students",
    "Our students say it changed their weekends",
    "4.9/5 from 200 people",
    "5 stars on every review",
  ]) {
    assert.equal(level(evaluate("social.post", post({ text }), makeCtx(), NOW), "testimonial"), "attest", text);
  }
});

test("strong claims need the user's attestation", () => {
  for (const text of ["Guaranteed results in one class", "Risk-free trial lesson", "Clay therapy cures anxiety"]) {
    assert.equal(level(evaluate("social.post", post({ text }), makeCtx(), NOW), "claims"), "attest", text);
  }
});

test("a link shortener is a warning, not a block", () => {
  const c = evaluate("social.post", post({ link: "https://bit.ly/abc" }), makeCtx(), NOW);
  assert.equal(level(c, "link_shortener"), "warn");
  assert.equal(isBlocked(c), false);
});

/* ---------------- email (CAN-SPAM) ---------------- */

const email = (over: Record<string, unknown> = {}) => ({
  connectionId: "mail", listId: "news", subject: "Saturday pottery class", bodyText: "Join us Saturday.",
  fromName: "Clay Studio", postalAddress: "12 Main St, Springfield, IL 62701", unsubscribeUrl: "https://example.com/unsub", ...over,
});

test("a compliant email campaign passes", () => {
  assert.deepEqual(evaluate("email.campaign", email(), makeCtx(), NOW), []);
});

test("purchased lists, missing unsubscribe or address, and fake RE: subjects are blocked", () => {
  assert.ok(ids(evaluate("email.campaign", email({ listId: "bought" }), makeCtx(), NOW)).includes("list_source"));
  assert.ok(ids(evaluate("email.campaign", email({ unsubscribeUrl: "" }), makeCtx(), NOW)).includes("unsubscribe"));
  assert.ok(ids(evaluate("email.campaign", email({ postalAddress: "" }), makeCtx(), NOW)).includes("postal_address"));
  assert.ok(ids(evaluate("email.campaign", email({ subject: "RE: your order" }), makeCtx(), NOW)).includes("deceptive_subject"));
  assert.ok(ids(evaluate("email.campaign", email({ listId: "texters" }), makeCtx(), NOW)).includes("unknown_list"), "an SMS list is not an email list");
});

/* ---------------- texts (TCPA) ---------------- */

const sms = (over: Record<string, unknown> = {}) => ({
  connectionId: "sms", listId: "texters", text: "Clay Studio: class Saturday 10am. Reply STOP to opt out.",
  audienceTimezone: "America/New_York", sendAt: "2026-11-10T19:00:00Z", ...over, // 2pm in New York
});

test("a consented, opt-out-labelled text at a reasonable hour passes", () => {
  assert.deepEqual(evaluate("sms.campaign", sms(), makeCtx(), NOW), []);
});

test("one recipient without consent blocks the whole send", () => {
  assert.ok(ids(evaluate("sms.campaign", sms({ listId: "partial" }), makeCtx(), NOW)).includes("sms_consent"));
});

test("no STOP instruction is blocked", () => {
  assert.ok(ids(evaluate("sms.campaign", sms({ text: "Class Saturday 10am!" }), makeCtx(), NOW)).includes("sms_opt_out"));
});

test("quiet hours are judged in the recipients' time zone", () => {
  // 03:00Z is 10pm the previous evening in New York, but 11am in Singapore.
  assert.ok(ids(evaluate("sms.campaign", sms({ sendAt: "2026-11-10T03:00:00Z" }), makeCtx(), NOW)).includes("quiet_hours"));
  assert.deepEqual(evaluate("sms.campaign", sms({ sendAt: "2026-11-10T03:00:00Z", audienceTimezone: "Asia/Singapore" }), makeCtx(), NOW), []);
  assert.ok(ids(evaluate("sms.campaign", sms({ audienceTimezone: "Mars/Olympus" }), makeCtx(), NOW)).includes("sms_time"));
});

/* ---------------- spending ---------------- */

const ad = (over: Record<string, unknown> = {}) => ({ connectionId: "ads", budgetCents: 2500, text: "Pottery for beginners", link: "https://example.com", ...over });

test("spending is off until the user sets a cap, and the cap is enforced", () => {
  assert.ok(ids(evaluate("ads.campaign", ad(), makeCtx(), NOW)).includes("no_spend_cap"));
  assert.ok(ids(evaluate("ads.campaign", ad(), makeCtx({ spendCapCents: 5000, spentThisMonthCents: 3000 }), NOW)).includes("over_spend_cap"));
  assert.deepEqual(evaluate("ads.campaign", ad(), makeCtx({ spendCapCents: 5000 }), NOW), []);
});

/* ---------------- sites ---------------- */

test("a site that was never scanned cannot be deployed, and scan problems carry through", () => {
  const H = "a".repeat(64);
  const p = { connectionId: "host", siteId: "s1", contentHash: H };
  assert.ok(ids(evaluate("site.deploy", p, makeCtx(), NOW)).includes("site_not_scanned"));
  const scanned = makeCtx({ siteScans: { s1: [{ id: "password_field", level: "block", message: "x" }] }, siteDigests: { s1: H } });
  assert.ok(ids(evaluate("site.deploy", p, scanned, NOW)).includes("password_field"));
  assert.deepEqual(evaluate("site.deploy", p, makeCtx({ siteScans: { s1: [] }, siteDigests: { s1: H } }), NOW), []);
});

test("a site whose files changed after the proposal cannot be deployed", () => {
  const p = { connectionId: "host", siteId: "s1", contentHash: "a".repeat(64) };
  const changed = makeCtx({ siteScans: { s1: [] }, siteDigests: { s1: "b".repeat(64) } });
  assert.ok(ids(evaluate("site.deploy", p, changed, NOW)).includes("site_changed"));
  assert.ok(ids(evaluate("site.deploy", { ...p, contentHash: "not-a-hash" }, changed, NOW)).includes("invalid"));
});
