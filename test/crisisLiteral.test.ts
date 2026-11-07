import { test } from "node:test";
import assert from "node:assert/strict";
import { crisisLiteral } from "../src/safety/crisisLiteral.ts";

const hits = [
  "I want to die",
  "I'm going to kill myself",
  "I’m going to end it",                       // smart apostrophe + the contraction that used to miss
  "I am going to end my life tonight",
  "i don’t want to live anymore",              // smart apostrophe
  "I don't want to be here any more",
  "I'm planning to end it all",
  "I'm feeling suicidal",
  "everyone would be better off without me",
  "there's no point in living",
  "I’m ready to end my life",
];

const misses = [
  "Dr. Kill, 3pm",
  "finish Sylvia Plath essay",
  "this deadline is killing me",
  "therapy appointment Thursday 4pm",
  "lunch with Dana at noon",
  "end of life care seminar",
];

for (const s of hits) {
  test(`literal pass catches: ${s}`, () => {
    assert.equal(crisisLiteral(s).hit, true);
  });
}

for (const s of misses) {
  test(`literal pass ignores: ${s}`, () => {
    assert.equal(crisisLiteral(s).hit, false);
  });
}

test("a coursework word marks the hit dampened but does not erase it", () => {
  const r = crisisLiteral("I can't finish this assignment, I want to kill myself");
  assert.equal(r.hit, true);
  assert.equal(r.dampened, true);
});

test("a hit with no coursework context is not dampened", () => {
  assert.equal(crisisLiteral("I want to kill myself").dampened, false);
});
