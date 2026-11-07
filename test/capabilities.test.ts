process.env.ANTHROPIC_API_KEY ||= "test-key";

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertWritable, isWritable, writableTargets, NotWritableError,
  CAPABILITIES, UNIVERSAL_DISCLOSURE, DISCLOSURE_VERSION,
} from "../src/providers/capabilities.ts";
import { redactPII } from "../src/safety/moderation.ts";

/* ---------------- write guard ---------------- */

test("an iCal feed can never be written to", () => {
  for (const p of ["canvas_ical", "blackboard_ical"] as const) {
    for (const intent of ["create", "update", "delete"] as const) {
      assert.throws(() => assertWritable(p, intent), NotWritableError, `${p}/${intent}`);
    }
  }
});

test("the refusal carries copy a user can read, not an error code", () => {
  try {
    assertWritable("canvas_ical", "create");
    assert.fail("should have thrown");
  } catch (e) {
    const err = e as NotWritableError;
    assert.match(err.userMessage, /read-only/i);
    assert.ok(!/undefined|null|Error:/.test(err.userMessage));
    assert.ok(err.userMessage.length > 40, "refusal should explain, not just deny");
  }
});

test("Google and Microsoft accept all three intents", () => {
  for (const p of ["google", "microsoft"] as const) {
    for (const intent of ["create", "update", "delete"] as const) {
      assert.doesNotThrow(() => assertWritable(p, intent));
    }
  }
});

test("Canvas API allows creating personal events but not editing instructor ones", () => {
  assert.doesNotThrow(() => assertWritable("canvas_api", "create"));
  assert.throws(() => assertWritable("canvas_api", "update"), NotWritableError);
  assert.throws(() => assertWritable("canvas_api", "delete"), NotWritableError);
});

test("the target picker only offers writable calendars", () => {
  const t = writableTargets(["canvas_ical", "google", "blackboard_ical", "microsoft"]);
  assert.deepEqual(t, ["google", "microsoft"]);
});

test("every provider has a disclosure and every read-only one explains itself", () => {
  for (const [name, cap] of Object.entries(CAPABILITIES)) {
    assert.ok(cap.disclosure.length > 60, `${name} disclosure too thin`);
    if (cap.write === "none") {
      assert.ok(cap.writeRefusal, `${name} has no refusal copy`);
      assert.match(cap.disclosure, /read-only/i, `${name} must say read-only up front`);
    }
    if (cap.write !== "none") {
      assert.ok(cap.scopes.length > 0, `${name} claims write with no scopes`);
    }
  }
});

test("the universal disclosure names the three things that bite", () => {
  const all = UNIVERSAL_DISCLOSURE.join(" ");
  assert.match(all, /confirm/i);
  assert.match(all, /misread/i);
  assert.match(all, /read-only/i);
  assert.equal(typeof DISCLOSURE_VERSION, "number");
});

/* ---------------- redaction ---------------- */

test("a real card number is redacted", () => {
  const r = redactPII("card 4242 4242 4242 4242 on file");
  assert.match(r.sanitized, /\[REDACTED:payment_card\]/);
  assert.ok(r.types.includes("payment_card"));
});

test("a Zoom meeting id is NOT mistaken for a card number", () => {
  const r = redactPII("Join https://zoom.us/j/98765432101 at 3pm");
  assert.ok(!/REDACTED/.test(r.sanitized), r.sanitized);
});

test("a long non-Luhn digit run survives untouched", () => {
  const r = redactPII("Order reference 1234567890123456 shipped");
  assert.ok(!/REDACTED/.test(r.sanitized), r.sanitized);
});

test("an SSN is redacted", () => {
  const r = redactPII("ssn 123-45-6789");
  assert.match(r.sanitized, /\[REDACTED:us_ssn\]/);
});

test("multiple occurrences of one pattern are all redacted", () => {
  const r = redactPII("123-45-6789 and 987-65-4321");
  assert.equal(r.sanitized.match(/REDACTED:us_ssn/g)?.length, 2);
  assert.equal(r.types.filter((t) => t === "us_ssn").length, 1, "types should not duplicate");
});

test("ordinary event text is left completely alone", () => {
  const text = "Design review 3:00 PM, Hall B, bring the Q3 deck";
  assert.equal(redactPII(text).sanitized, text);
  assert.deepEqual(redactPII(text).types, []);
});

test("redaction is idempotent", () => {
  const once = redactPII("card 4242424242424242").sanitized;
  assert.equal(redactPII(once).sanitized, once);
});
