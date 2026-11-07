/**
 * The literal crisis pass: unambiguous first-person language, matched with no network call.
 * Kept free of any SDK import so it can be unit-tested directly.
 *
 * Three properties this module exists to guarantee, each of which an earlier version broke:
 *  1. Smart quotes match. Apple keyboards type U+2019, so "don’t want to live" must hit.
 *  2. "I'm going to ..." matches. The old pattern needed a space after "i", which an
 *     apostrophe contraction never has.
 *  3. A coursework word ("essay", "assignment") never silences the pass. It only changes
 *     what happens next: the caller sends a dampened hit to the classifier and, if the
 *     classifier is unavailable, treats it as a crisis rather than waving it through.
 */

/** Curly and modifier apostrophes and backticks -> ASCII, and collapse whitespace. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const CRISIS_LITERAL: RegExp[] = [
  // "I want to die", "I'm going to kill myself", "I am planning to end it all", "I'm ready to end my life"
  /\bi(?: am|'m)? (?:going|planning|want|wanna|need|plan|ready|about|have decided|decided) to (?:die|be dead|kill myself|end (?:it|it all|my life|my own life|everything)|hurt myself|take my own life)\b/i,
  /\bi (?:don'?t|do not) want to (?:be here|live|wake up|exist) any ?more\b/i,
  /\bi (?:don'?t|do not) want to (?:be alive|live)\b/i,
  /\b(?:kill|killing) myself\b/i,
  /\bend(?:ing)? (?:my|my own) life\b/i,
  /\btake my own life\b/i,
  /\bi(?: am|'m) (?:feeling )?suicidal\b/i,
  /\bi(?: am|'m) going to hurt (?:myself|somebody|someone|him|her|them)\b/i,
  /\bno (?:reason|point) (?:to|in) (?:living|going on|being alive)\b/i,
  /\b(?:better off|everyone would be better off) without me\b/i,
];

/** Contexts where the phrases above are often quotation rather than disclosure. They do NOT
 *  suppress the match; they route it to a second opinion. */
const QUOTATION_CONTEXT =
  /\b(song|lyric|lyrics|movie|film|novel|essay|chapter|episode|album|podcast|quote|quoted|character|assignment|thesis|screenplay|poem|play|book|article|paper)\b/i;

export interface LiteralResult {
  /** A crisis phrase is present. */
  hit: boolean;
  /** ...and the message also contains quotation/coursework context. */
  dampened: boolean;
}

export function crisisLiteral(text: string): LiteralResult {
  const t = normalizeForMatch(text);
  const hit = CRISIS_LITERAL.some((re) => re.test(t));
  return { hit, dampened: hit && QUOTATION_CONTEXT.test(t) };
}
