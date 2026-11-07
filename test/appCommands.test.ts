import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAppCommand, normalize, type AppInfo } from "../src/apps/commands.ts";

const app = (id: string, name: string, over: Partial<AppInfo> = {}): AppInfo => ({ id, name, running: false, protected: false, ...over });
const ALLOWED = [
  app("us.zoom.xos", "Zoom"),
  app("com.tinyspeck.slackmacgap", "Slack"),
  app("com.apple.calculator", "Calculator"),
  app("com.google.Chrome", "Google Chrome", { protected: true }),
  app("com.microsoft.Word", "Microsoft Word"),
  app("com.microsoft.Excel", "Microsoft Excel"),
];

const match = (text: string) => parseAppCommand(text, ALLOWED);

test("the plain forms work", () => {
  const r = match("open zoom");
  assert.deepEqual(r.kind === "match" && [r.verb, r.app.id], ["open", "us.zoom.xos"]);
  const q = match("quit slack");
  assert.deepEqual(q.kind === "match" && [q.verb, q.app.id], ["close", "com.tinyspeck.slackmacgap"]);
});

test("every opening and closing verb is understood", () => {
  for (const v of ["open", "launch", "start", "run"]) assert.equal(match(`${v} zoom`).kind === "match" && (match(`${v} zoom`) as any).verb, "open", v);
  for (const v of ["close", "quit", "exit"]) assert.equal(match(`${v} zoom`).kind === "match" && (match(`${v} zoom`) as any).verb, "close", v);
  const r = match("shut down zoom");
  assert.equal(r.kind === "match" && r.verb, "close");
});

test("force-style words are NOT understood, because this never force-quits", () => {
  for (const v of ["kill", "stop", "terminate", "destroy", "force quit"]) {
    assert.equal(match(`${v} zoom`).kind, "none", v);
  }
});

test("polite and padded phrasing is understood, in any case", () => {
  for (const t of ["Please open the Zoom app", "can you launch zoom", "OPEN   ZOOM", "could you quit my slack please", "hey open zoom for me", "open zoom!"]) {
    assert.equal(match(t).kind, "match", t);
  }
});

test("a partial name finds the app, whole-word and prefix", () => {
  assert.equal((match("open chrome") as any).app.id, "com.google.Chrome");
  assert.equal((match("open calc") as any).app.id, "com.apple.calculator");
});

test("an exact name beats a longer name that merely contains it", () => {
  const apps = [app("a.word", "Word"), app("b.msword", "Microsoft Word")];
  const r = parseAppCommand("open word", apps);
  assert.equal(r.kind === "match" && r.app.id, "a.word");
});

test("a name shared by several allowed apps is ambiguous rather than guessed", () => {
  const r = match("open microsoft");
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual(r.kind === "ambiguous" && r.candidates.map((c) => c.id).sort(), ["com.microsoft.Excel", "com.microsoft.Word"]);
});

test("an app the user has not allowed does not match, even if it is installed", () => {
  assert.deepEqual(match("open photoshop"), { kind: "none", reason: "no_app" });
  assert.equal(parseAppCommand("open zoom", []).kind, "none");
});

test("text that is not a command is ignored, never turned into an action", () => {
  assert.deepEqual(match("zoom"), { kind: "none", reason: "no_verb" });
  assert.deepEqual(match("what's the weather"), { kind: "none", reason: "no_verb" });
  assert.deepEqual(match(""), { kind: "none", reason: "empty" });
  assert.deepEqual(match("   "), { kind: "none", reason: "empty" });
  assert.deepEqual(match("open"), { kind: "none", reason: "no_app" });
  assert.deepEqual(match("open the app"), { kind: "none", reason: "no_app" });
});

test("only one app per command: a compound request does not guess", () => {
  assert.equal(match("open zoom and slack").kind, "none");
});

test("injection-looking input is just text that fails to match", () => {
  for (const t of ["open zoom; rm -rf ~", 'open "zoom" && quit slack', "open $(whoami)", "open ../../etc", "open zoom\nquit slack"]) {
    const r = match(t);
    if (r.kind === "match") assert.ok(ALLOWED.includes(r.app), t); // if anything matches, it is an allowed app object
  }
  assert.equal(match("open $(whoami)").kind, "none");
  assert.equal(match("open ../../etc").kind, "none");
});

test("very long input is refused outright", () => {
  assert.deepEqual(match("open " + "a".repeat(500)), { kind: "none", reason: "too_long" });
});

test("normalize treats punctuation and case alike", () => {
  assert.equal(normalize("Zoom.us"), "zoom us");
  assert.equal(normalize("  ZOOM!!  "), "zoom");
});
