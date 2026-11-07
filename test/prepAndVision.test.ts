process.env.ANTHROPIC_API_KEY ||= "test-key";

import test from "node:test";
import assert from "node:assert/strict";
import { advisoryLint, stripFabricatedUrls, type Audit, type EventInput } from "../src/prep/requirementAudit.ts";
import { applyReviewPolicy } from "../src/vision/imageToEvents.ts";

const base: Audit = { requirements: [], suggested_approach: [], reference_links: [], unresolved: [] };
const req = (label: string, o: any = {}) =>
  ({ label, detail: null, url: null, provenance: "from_event" as const, lead_time_minutes: 10, ...o });

/* ---------------- advisory lint ---------------- */

test("imperative verb openers are rewritten as observations", () => {
  const out = advisoryLint({ ...base, requirements: [req("Download the Q3 deck")] });
  assert.equal(out.requirements[0].label, "Q3 deck — worth having ready");
});

test("'make sure' phrasing is stripped and stays capitalised", () => {
  const out = advisoryLint({ ...base, requirements: [req("Make sure you have the Zoom link")] });
  const label = out.requirements[0].label;
  assert.ok(!/make sure/i.test(label), `still commanding: ${label}`);
  assert.equal(label[0], label[0].toUpperCase(), `lost capitalisation: ${label}`);
});

test("already-advisory phrasing is left untouched", () => {
  const original = "Q3 slide deck — attached to this event";
  const out = advisoryLint({ ...base, requirements: [req(original)] });
  assert.equal(out.requirements[0].label, original);
});

test("a noun that merely starts with a command-like word is not mangled", () => {
  const out = advisoryLint({ ...base, requirements: [req("Review notes from last sprint")] });
  assert.ok(out.requirements[0].label.length > 0);
});

test("suggested approach steps are softened too", () => {
  const out = advisoryLint({
    ...base,
    suggested_approach: [{ step: "Finish the outline first", rough_minutes: 20 }],
  });
  assert.ok(!/^finish/i.test(out.suggested_approach[0].step));
});

/* ---------------- URL fabrication guard ---------------- */

const ev: EventInput = {
  title: "Design review",
  description: "Join at https://zoom.us/j/999 — deck attached",
  location: null, attachments: [{ name: "q3.pdf", mimeType: "application/pdf" }],
  conferenceUrl: "https://zoom.us/j/999",
  start: new Date(), end: new Date(), category: "meeting", source: "google",
};

test("a model-invented URL is stripped even if it looks plausible", () => {
  const out = stripFabricatedUrls(
    { ...base, requirements: [req("Course page", { url: "https://canvas.example.edu/courses/210", provenance: "model_suggested" })] },
    ev
  );
  assert.equal(out.requirements[0].url, null);
});

test("a URL claimed as from_event but absent from the event text is stripped", () => {
  const out = stripFabricatedUrls(
    { ...base, requirements: [req("Zoom", { url: "https://zoom.us/j/000", provenance: "from_event" })] },
    ev
  );
  assert.equal(out.requirements[0].url, null);
});

test("a URL genuinely present in the event survives", () => {
  const out = stripFabricatedUrls(
    { ...base, requirements: [req("Zoom", { url: "https://zoom.us/j/999", provenance: "from_event" })] },
    ev
  );
  assert.equal(out.requirements[0].url, "https://zoom.us/j/999");
});

test("model-suggested reference links are dropped entirely", () => {
  const out = stripFabricatedUrls(
    { ...base, reference_links: [{ label: "APA guide", url: "https://apastyle.apa.org", provenance: "model_suggested" }] },
    ev
  );
  assert.equal(out.reference_links.length, 0);
});

/* ---------------- vision review policy ---------------- */

const vev = (o: any = {}) => ({
  title: "Recital", start_time: "2026-03-03T19:00:00-05:00", end_time: null, all_day: false,
  location: "Hall B", description: null,
  confidence: { title: 0.98, start_time: 0.97, end_time: 0.9, location: 0.95 },
  source_text: "March 3, 7pm", assumptions: [], needs_review: [], ...o,
});
const vres = (events: any[], legibility: any = "clear") =>
  ({ events, image_type: "flyer" as const, legibility, notes: null });

test("a low-confidence field is flagged even when the model did not flag it", () => {
  const out = applyReviewPolicy(vres([vev({ confidence: { title: 0.4, start_time: 0.97, end_time: 0.9, location: 0.95 } })]) as any);
  assert.ok(out.events[0].needs_review.includes("title"));
});

test("a null start time is always flagged", () => {
  const out = applyReviewPolicy(vres([vev({ start_time: null })]) as any);
  assert.ok(out.events[0].needs_review.includes("start_time"));
});

test("a missing end time on a timed event is flagged", () => {
  const out = applyReviewPolicy(vres([vev({ end_time: null, all_day: false })]) as any);
  assert.ok(out.events[0].needs_review.includes("end_time"));
});

test("an all-day event is not flagged for a missing end time", () => {
  const out = applyReviewPolicy(vres([vev({ end_time: null, all_day: true })]) as any);
  assert.ok(!out.events[0].needs_review.includes("end_time"));
});

test("poor legibility flags the whole extraction", () => {
  const out = applyReviewPolicy(vres([vev()], "poor") as any);
  assert.ok(out.events[0].needs_review.includes("_image_legibility"));
});

test("a clean high-confidence extraction is flagged for nothing", () => {
  const out = applyReviewPolicy(vres([vev({ end_time: "2026-03-03T21:00:00-05:00" })]) as any);
  assert.deepEqual(out.events[0].needs_review, []);
});

test("flags are deduplicated when model and policy agree", () => {
  const out = applyReviewPolicy(vres([vev({ start_time: null, needs_review: ["start_time"] })]) as any);
  assert.equal(out.events[0].needs_review.filter((f: string) => f === "start_time").length, 1);
});
