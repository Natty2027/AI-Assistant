/**
 * Turns what the user typed ("open zoom", "please quit the slack app") into an app and a verb.
 *
 * Deterministic on purpose, and no AI model is involved. Launching and closing programs is
 * exactly the kind of action that must not depend on a model's reading of some text, and the
 * only input here is what the person typed into the panel themselves. Nothing from a web page,
 * a calendar entry or a captured image ever reaches this function.
 *
 * It is only ever given the apps the user has allowed, so a name outside that list simply does
 * not match.
 */

export interface AppInfo {
  id: string;
  name: string;
  running: boolean;
  protected: boolean;
}

export type Verb = "open" | "close";

export type ParseResult =
  | { kind: "none"; reason: "empty" | "too_long" | "no_verb" | "no_app" }
  | { kind: "match"; verb: Verb; app: AppInfo }
  | { kind: "ambiguous"; verb: Verb; candidates: AppInfo[] };

const OPEN_WORDS = new Set(["open", "launch", "start", "run"]);
// "kill" and "stop" are deliberately absent: they suggest force and are not what this does.
const CLOSE_WORDS = new Set(["close", "quit", "exit"]);

const MAX_INPUT = 100;

/** Lowercase, punctuation to spaces, collapsed. "Zoom.us" and "zoom us" compare equal. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function parseAppCommand(input: string, allowed: AppInfo[]): ParseResult {
  const raw = (input ?? "").trim();
  if (!raw) return { kind: "none", reason: "empty" };
  if (raw.length > MAX_INPUT) return { kind: "none", reason: "too_long" };

  let words = normalize(raw).split(" ").filter(Boolean);
  // Polite padding: "please open ...", "can you quit ...", "could you launch ..."
  while (words.length && ["please", "pls", "can", "could", "would", "you", "hey"].includes(words[0])) words.shift();

  let verb: Verb | null = null;
  if (words[0] === "shut" && words[1] === "down") { verb = "close"; words = words.slice(2); }
  else if (words.length && OPEN_WORDS.has(words[0])) { verb = "open"; words.shift(); }
  else if (words.length && CLOSE_WORDS.has(words[0])) { verb = "close"; words.shift(); }
  if (!verb) return { kind: "none", reason: "no_verb" };

  // Trim filler on either side of the app's name.
  while (words.length && ["the", "my", "up"].includes(words[0])) words.shift();
  while (words.length && ["app", "application", "please", "pls", "for", "me"].includes(words[words.length - 1])) words.pop();
  const target = words.join(" ");
  if (!target) return { kind: "none", reason: "no_app" };

  // Best tier wins: exact name, then a name that starts with it, then a whole word inside a name.
  const tiers: AppInfo[][] = [[], [], []];
  for (const app of allowed) {
    const name = normalize(app.name);
    if (name === target) tiers[0].push(app);
    else if (name.startsWith(target + " ") || name.startsWith(target)) tiers[1].push(app);
    else if (` ${name} `.includes(` ${target} `)) tiers[2].push(app);
  }
  const best = tiers.find((t) => t.length > 0);
  if (!best) return { kind: "none", reason: "no_app" };
  if (best.length === 1) return { kind: "match", verb, app: best[0] };
  return { kind: "ambiguous", verb, candidates: best };
}
