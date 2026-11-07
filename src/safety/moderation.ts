/**
 * Enforcement layer. The system prompt shapes the model; this file stops it.
 *
 * Design notes:
 *  - Two stages. A narrow literal pass catches unambiguous language at ~0ms and 0 cost.
 *    Everything else that looks even slightly concerning goes to a small classifier. The
 *    literal pass is deliberately tiny: broad keyword lists produce constant false positives
 *    on a calendar app, where users legitimately type things like "Dr. Kill, 3pm" or
 *    "finish Sylvia Plath essay".
 *  - Crisis interception happens BEFORE the main model call and BEFORE any tool is bound.
 *    The main model never sees the turn, so it cannot be talked into continuing the task.
 *  - Crisis content is never persisted. We store a boolean event with a timestamp for
 *    rate-limiting and nothing else. It is never an input to the habit engine.
 */

import Anthropic from "@anthropic-ai/sdk";
import { crisisLiteral } from "./crisisLiteral";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

export type Verdict =
  | { action: "allow" }
  | { action: "crisis"; confidence: number }
  | { action: "block"; category: BlockCategory; userMessage: string }
  | { action: "redact"; sanitized: string; redactedTypes: string[] };

export type BlockCategory =
  | "minor_safety"
  | "violence"
  | "illegal"
  | "sexual"
  | "harassment"
  | "prompt_injection";

/* ------------------------------------------------------------------ */
/* Stage 0 — PII redaction. Runs on every input, including OCR output. */
/* ------------------------------------------------------------------ */

const PII_PATTERNS: Array<[string, RegExp]> = [
  ["us_ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["api_key", /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,})\b/g],
];

const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Luhn check. Without it, the digit run matches phone numbers, order references, and the
 *  long numeric IDs in conference links — redacting a Zoom meeting ID out of an event is a
 *  worse bug than the one the pattern was added to prevent. */
function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactPII(input: string): { sanitized: string; types: string[] } {
  const types = new Set<string>();

  let out = input.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[^0-9]/g, "");
    if (!passesLuhn(digits)) return match;
    types.add("payment_card");
    return "[REDACTED:payment_card]";
  });

  for (const [label, re] of PII_PATTERNS) {
    // Compare rather than test-then-replace: a /g regex carries lastIndex across calls, and
    // the test/replace pairing was one refactor away from skipping every other match.
    const next = out.replace(re, `[REDACTED:${label}]`);
    if (next !== out) types.add(label);
    out = next;
  }

  return { sanitized: out, types: [...types] };
}

/* ------------------------------------------------------------------ */
/* Stage 1 — literal pass. High precision only. Nothing speculative.   */
/* ------------------------------------------------------------------ */

// The crisis patterns live in ./crisisLiteral.ts so they can be unit-tested without the SDK.

const INJECTION_LITERAL =
  /\b(ignore (?:all |your )?(?:previous|prior|above) instructions|disregard (?:the )?system prompt|you are now (?:in )?(?:developer|dan|god) mode|reveal your (?:system )?prompt)\b/i;

/* ------------------------------------------------------------------ */
/* Stage 2 — semantic classifier.                                      */
/* ------------------------------------------------------------------ */

const CLASSIFIER_PROMPT = `You classify a single user message sent to a calendar assistant.

Return ONLY a JSON object, no prose, no markdown fences:
{"crisis": bool, "crisis_confidence": 0.0-1.0, "category": null | "minor_safety" | "violence" | "illegal" | "sexual" | "harassment", "reason": "<12 words"}

"crisis" is true only when the message expresses the user's own suicidal intent or ideation,
intent to self-harm, intent to harm another person, or that they are in immediate danger.

"crisis" is FALSE for: quoting media, coursework about these topics, scheduling a therapy or
psychiatry appointment, describing stress or exhaustion, hyperbole ("this deadline is killing
me"), or concern about a third party in the abstract.

"category" is non-null only for content the assistant should refuse outright. Scheduling a
court date, a medical procedure, a security audit, or a firearms-safety class is NOT a
category — those are ordinary calendar entries.`;

async function classify(text: string): Promise<{
  crisis: boolean;
  crisis_confidence: number;
  category: BlockCategory | null;
  /** True when the classifier could not be reached or returned something unparseable. */
  failed?: boolean;
}> {
  try {
    const res = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 150,
      temperature: 0,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: `<message>${text.slice(0, 4000)}</message>` }],
    });
    const raw = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .replace(/```json|```/g, "")
      .trim();
    const parsed = JSON.parse(raw);
    return {
      crisis: Boolean(parsed.crisis),
      crisis_confidence: Number(parsed.crisis_confidence) || 0,
      category: parsed.category ?? null,
    };
  } catch {
    // Do not fabricate a crisis from an outage: report "unknown" and let the caller decide.
    // The caller fails closed only where the literal pass has already seen a crisis phrase
    // (see moderateInput); everywhere else an API blip must not look like a refusal loop.
    console.error("[moderation] classifier failed");
    return { crisis: false, crisis_confidence: 0, category: null, failed: true };
  }
}

/* ------------------------------------------------------------------ */
/* Public entry point. Call this before every model invocation.        */
/* ------------------------------------------------------------------ */

export async function moderateInput(
  rawInput: string,
  opts: { source: "text" | "voice_transcript" | "ocr" | "feed"; userId: string }
): Promise<Verdict> {
  // Content arriving from images or calendar feeds is data, never a directive.
  if (opts.source === "ocr" || opts.source === "feed") {
    const { sanitized, types } = redactPII(rawInput);
    if (INJECTION_LITERAL.test(sanitized)) {
      return {
        action: "block",
        category: "prompt_injection",
        userMessage:
          "This file contains text that looks like an attempt to give the assistant " +
          "instructions. I've ignored it and won't act on it.",
      };
    }
    return types.length
      ? { action: "redact", sanitized, redactedTypes: types }
      : { action: "allow" };
  }

  const { sanitized, types } = redactPII(rawInput);

  const literal = crisisLiteral(sanitized);

  // An undampened phrase is intercepted immediately. A dampened one ("...this assignment, I
  // want to kill myself") gets a second opinion, but is never waved through on the strength
  // of a coursework word alone.
  if (literal.hit && !literal.dampened) {
    await recordSafetyEvent(opts.userId, "crisis_intercept", "literal");
    return { action: "crisis", confidence: 0.95 };
  }

  const verdict = await classify(sanitized);

  // Fail closed ONLY here: a crisis phrase was seen and the classifier that would clear it
  // is unavailable. Missing a real disclosure is the one error that cannot be undone.
  if (literal.hit && verdict.failed) {
    await recordSafetyEvent(opts.userId, "crisis_intercept", "literal_unverified");
    return { action: "crisis", confidence: 0.8 };
  }

  if (verdict.crisis && verdict.crisis_confidence >= 0.6) {
    await recordSafetyEvent(opts.userId, "crisis_intercept", "semantic");
    return { action: "crisis", confidence: verdict.crisis_confidence };
  }

  if (verdict.category) {
    await recordSafetyEvent(opts.userId, "content_block", verdict.category);
    return {
      action: "block",
      category: verdict.category,
      userMessage:
        verdict.category === "minor_safety"
          ? "I can't help with that."
          : "That's outside what I can help with. I'm here for scheduling — want to pick " +
            "that back up?",
    };
  }

  return types.length
    ? { action: "redact", sanitized, redactedTypes: types }
    : { action: "allow" };
}

/* ------------------------------------------------------------------ */
/* Tool gating.                                                        */
/* ------------------------------------------------------------------ */

/**
 * Crisis turns get an empty tool array. This is the actual hard stop — the model is
 * structurally unable to touch a calendar on that turn, regardless of what it decides.
 */
export function toolsForTurn(verdict: Verdict, allTools: unknown[]): unknown[] {
  return verdict.action === "crisis" || verdict.action === "block" ? [] : allTools;
}

/* ------------------------------------------------------------------ */
/* Output check. Cheap, narrow, catches the failure that matters most. */
/* ------------------------------------------------------------------ */

const METHOD_LEAK =
  /\b(overdose|hang(?:ing)? (?:yourself|myself)|how (?:much|many) .{0,20}(?:lethal|fatal|kill))\b/i;

export function moderateOutput(text: string): { safe: boolean; replacement?: string } {
  if (METHOD_LEAK.test(text)) {
    return {
      safe: false,
      replacement:
        "I'm not able to go into that. If you're struggling, 988 (call or text, US) or " +
        "findahelpline.com will connect you with someone who can help.",
    };
  }
  return { safe: true };
}

/* ------------------------------------------------------------------ */
/* Logging — deliberately content-free.                                */
/* ------------------------------------------------------------------ */

async function recordSafetyEvent(
  userId: string,
  kind: "crisis_intercept" | "content_block",
  detector: string
): Promise<void> {
  // Writes only: user_id, kind, detector, timestamp. Never the message text.
  // See db/schema.sql -> safety_events. This row is excluded from habit inference and
  // from enterprise audit exports that contain user content.
  await fetch(`${process.env.INTERNAL_API}/safety-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, kind, detector, at: new Date().toISOString() }),
  }).catch(() => void 0);
}
