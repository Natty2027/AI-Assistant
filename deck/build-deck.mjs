/**
 * Builds the partner briefing deck.   npm run deck
 *
 * Output: deck/Ambient-Cyber-Companion-Partner-Briefing.pptx (opens in PowerPoint, Keynote and
 * Google Slides). Every claim here is drawn from PRODUCT-OVERVIEW.md and CODE-REVIEW.md; the
 * "where we are" slide mirrors the claims check in that document, so the deck does not promise
 * more than the product does today.
 */
import PptxGenJS from "pptxgenjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "Ambient-Cyber-Companion-Partner-Briefing.pptx");

// The extension's own palette (ext/ui/theme.css, dark theme), so the deck looks like the product.
const C = {
  ground: "14171C", surface: "1D2026", raised: "22262E", edge: "2A2E36",
  bone: "E4E1DB", muted: "A0A5AE", faint: "6E747E",
  sand: "C8A98A", sage: "7FA8A0", danger: "D97757",
};
const FONT = "Arial"; // present on every machine; the product's own face is not

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
pptx.title = "Ambient Cyber Companion: Partner Briefing";
pptx.author = "Ambient Cyber Companion";

// With DECK_RECORD=<file>, every drawing call is also written to JSON, which deck/preview.mjs
// renders in a browser so the layout can be checked without PowerPoint or Keynote.
const RECORD = process.env.DECK_RECORD;
const recorded = [];
if (RECORD) {
  const realAddSlide = pptx.addSlide.bind(pptx);
  pptx.addSlide = (...a) => {
    const slide = realAddSlide(...a);
    const rec = { master: a[0]?.masterName ?? "MAIN", ops: [] };
    recorded.push(rec);
    return new Proxy(slide, {
      get(target, key) {
        const v = target[key];
        if (typeof v !== "function") return v;
        return (...args) => {
          if (["addText", "addShape", "addTable", "addImage"].includes(String(key))) rec.ops.push({ k: key, args });
          return v.apply(target, args);
        };
      },
    });
  };
}

pptx.defineSlideMaster({
  title: "TITLE", background: { color: C.ground }, objects: [],
});
pptx.defineSlideMaster({
  title: "MAIN",
  background: { color: C.ground },
  objects: [
    { text: { text: "Ambient Cyber Companion  ·  Partner briefing", options: { x: 0.7, y: 7.02, w: 7, h: 0.3, fontFace: FONT, fontSize: 10, color: C.faint, margin: 0 } } },
  ],
  slideNumber: { x: 12.0, y: 7.02, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: C.faint, align: "right" },
});

/* ---------------- helpers ---------------- */

function head(s, kicker, title) {
  s.addText(kicker.toUpperCase(), { x: 0.7, y: 0.42, w: 11.9, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.sage, charSpacing: 3, margin: 0 });
  s.addText(title, { x: 0.7, y: 0.78, w: 11.9, h: 1.15, fontFace: FONT, fontSize: 30, bold: true, color: C.bone, valign: "top", margin: 0 });
}

/** A rounded card with an accent bar, a heading and body text. */
function card(s, { x, y, w, h, title, body, accent = C.sage, titleSize = 17, bodySize = 14 }) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.12, fill: { color: C.raised }, line: { color: C.edge, width: 1 } });
  s.addShape(pptx.ShapeType.rect, { x: x + 0.22, y: y + 0.26, w: 0.06, h: 0.34, fill: { color: accent }, line: { color: accent, width: 0 } });
  s.addText(title, { x: x + 0.42, y: y + 0.2, w: w - 0.62, h: 0.46, fontFace: FONT, fontSize: titleSize, bold: true, color: C.bone, valign: "middle", margin: 0 });
  s.addText(body, { x: x + 0.42, y: y + 0.74, w: w - 0.66, h: h - 0.9, fontFace: FONT, fontSize: bodySize, color: C.muted, valign: "top", margin: 0, paraSpaceAfter: 4 });
}

/** The product mark: a sage ring around a sand dot. */
function logo(s, cx, cy, r) {
  s.addShape(pptx.ShapeType.ellipse, { x: cx - r, y: cy - r, w: r * 2, h: r * 2, fill: { color: C.surface }, line: { color: C.sage, width: Math.max(3, r * 9) } });
  const d = r * 0.36;
  s.addShape(pptx.ShapeType.ellipse, { x: cx - d, y: cy - d, w: d * 2, h: d * 2, fill: { color: C.sand }, line: { color: C.sand, width: 0 } });
}

/**
 * A real screenshot of the panel (deck/assets, from `npm run deck:screens`), in a thin frame with a
 * small caption. The pictures are 760x1640, so the height fixes the width.
 */
function phone(s, file, { x, y = 1.75, h = 4.7, caption }) {
  const w = (h * 760) / 1640;
  s.addShape(pptx.ShapeType.roundRect, { x: x - 0.06, y: y - 0.06, w: w + 0.12, h: h + 0.12, rectRadius: 0.1, fill: { color: C.surface }, line: { color: C.sage, width: 1.5 } });
  s.addImage({ path: path.join(here, "assets", file), x, y, w, h });
  if (caption) s.addText(caption, { x: x - 0.4, y: y + h + 0.1, w: w + 0.8, h: 0.28, fontFace: FONT, fontSize: 10, italic: true, color: C.faint, align: "center", margin: 0 });
  return w;
}

/** A numbered line of explanation beside a screenshot. */
function point(s, { x, y, w, n, title, body }) {
  s.addShape(pptx.ShapeType.ellipse, { x, y: y + 0.04, w: 0.46, h: 0.46, fill: { color: C.sage }, line: { color: C.sage, width: 0 } });
  s.addText(String(n), { x, y: y + 0.04, w: 0.46, h: 0.46, fontFace: FONT, fontSize: 15, bold: true, color: C.ground, align: "center", valign: "middle", margin: 0 });
  s.addText(title, { x: x + 0.65, y, w: w - 0.65, h: 0.4, fontFace: FONT, fontSize: 17, bold: true, color: C.bone, valign: "middle", margin: 0 });
  s.addText(body, { x: x + 0.65, y: y + 0.45, w: w - 0.65, h: 0.75, fontFace: FONT, fontSize: 13, color: C.muted, valign: "top", margin: 0 });
}

const bullets = (items, opts = {}) =>
  items.map((t) => ({ text: t, options: { bullet: { code: "25CF", indent: 14 }, breakLine: true, ...opts } }));

/* ================= 1. title ================= */
{
  const s = pptx.addSlide({ masterName: "TITLE" });
  s.addText("PARTNER BRIEFING  ·  NOVEMBER 2026", { x: 0.9, y: 1.5, w: 8, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: C.sage, charSpacing: 3, margin: 0 });
  // Two lines at 46pt; the box is sized for that with room to spare, so it cannot spill.
  s.addText("Ambient Cyber Companion", { x: 0.9, y: 2.0, w: 8.2, h: 1.85, fontFace: FONT, fontSize: 46, bold: true, color: C.bone, valign: "top", margin: 0 });
  s.addText("The calendar assistant that knows when to stay quiet, and never touches your calendar without your say-so.", {
    x: 0.9, y: 4.1, w: 7.6, h: 1.4, fontFace: FONT, fontSize: 22, color: C.muted, valign: "top", margin: 0,
  });
  logo(s, 10.7, 3.75, 1.55);
  s.addText("A browser extension for Chrome, Edge and Firefox", { x: 0.9, y: 6.4, w: 8, h: 0.35, fontFace: FONT, fontSize: 13, color: C.faint, margin: 0 });
  s.addNotes(
    "Open by naming the one-line idea: an assistant that reads the room. Most calendar tools optimise your schedule; " +
    "this one first asks whether it should be speaking at all. This briefing covers what it does, why it is different, " +
    "an honest account of where it stands, and the decisions I need from this group."
  );
}

/* ================= 2. problem ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "The problem", "Assistants got good at doing things. Few know when not to.");
  const W = 5.85, H = 1.85, X1 = 0.7, X2 = 6.75, Y1 = 2.2, Y2 = 4.25;
  card(s, { x: X1, y: Y1, w: W, h: H, accent: C.danger, title: "Bad timing", body: "It chimes in during a lecture, a client call, or an exam." });
  card(s, { x: X2, y: Y1, w: W, h: H, accent: C.danger, title: "Talking over you", body: "It speaks while you are sharing your screen to a room full of people." });
  card(s, { x: X1, y: Y2, w: W, h: H, accent: C.danger, title: "Surprise changes", body: "It reschedules things on its own, and you find out afterwards." });
  card(s, { x: X2, y: Y2, w: W, h: H, accent: C.danger, title: "Retyping, and mistyping", body: "Getting an event off a flyer or a whiteboard means typing it in, and it is easy to get the date wrong." });
  s.addText("And to do any of it, these tools want broad access to your data while saying little about what happens to it.", {
    x: 0.7, y: 6.3, w: 11.9, h: 0.5, fontFace: FONT, fontSize: 14, italic: true, color: C.sand, margin: 0,
  });
  s.addNotes(
    "Frame the pain in everyday terms. Ask the room whether they have had a notification go off in the wrong moment. " +
    "The last line is the trust gap: the more automatic a tool is, the more access it asks for and the less it explains."
  );
}

/* ================= 3. idea ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "Our idea", "Be present when you want it, silent when you don't, and never act without a clear yes.");
  const cols = [
    { n: "1", t: "Context before action", b: "Before it speaks, it checks what you are doing: in class, in a meeting, in an exam, sharing your screen, on a call." },
    { n: "2", t: "Nothing without your yes", b: "Every event it suggests waits for your tap. Nothing is added, moved or deleted on its own, and the database enforces it." },
    { n: "3", t: "Honest about uncertainty", b: "If it is not sure of a date or time, it leaves it blank and asks you, instead of showing a confident wrong answer." },
  ];
  cols.forEach((c, i) => {
    const x = 0.7 + i * 4.025;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 2.35, w: 3.85, h: 3.85, rectRadius: 0.12, fill: { color: C.raised }, line: { color: C.edge, width: 1 } });
    s.addText(c.n, { x: x + 0.35, y: 2.55, w: 1, h: 0.9, fontFace: FONT, fontSize: 48, bold: true, color: C.sand, margin: 0 });
    s.addText(c.t, { x: x + 0.35, y: 3.55, w: 3.2, h: 0.8, fontFace: FONT, fontSize: 20, bold: true, color: C.bone, valign: "top", margin: 0 });
    s.addText(c.b, { x: x + 0.35, y: 4.4, w: 3.2, h: 1.9, fontFace: FONT, fontSize: 14, color: C.muted, valign: "top", margin: 0 });
  });
  s.addNotes(
    "These three ideas run through every feature. If a partner remembers only one slide, it should be this one. " +
    "Note that the second and third are not marketing language: each is enforced by something in the system, which the trust slide covers."
  );
}

/* ================= the panel at a glance ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "The product", "The panel, at a glance.");
  phone(s, "panel-overview.png", { x: 0.95, caption: "Sample day, from the panel's built-in demo data" });
  const x = 4.3, w = 8.3;
  point(s, { x, y: 1.95, w, n: 1, title: "It tells you why it is quiet", body: "The header shows its state and the reason. Here a lecture is in progress, so it stays muted until it ends." });
  point(s, { x, y: 3.45, w, n: 2, title: "Your day, with what is happening now", body: "A plain timeline of today, with a progress line on the event in progress." });
  point(s, { x, y: 4.95, w, n: 3, title: "Nothing is lost while you are busy", body: "Alerts that would have interrupted you wait in a held list. Play them when you are free, or dismiss them." });
  s.addNotes(
    "This is the real panel, rendered from the built extension, not a mock-up. The data is the panel's own sample day, so the lecture and the held alerts are illustrative. " +
    "Point at the header first: the product's whole premise is that it can say why it is quiet. The footer reminder that AI can make mistakes is permanent by design."
  );
}

/* ================= 4. reads the room ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "How it works", "It reads the room before it speaks.");
  s.addText("What it watches", { x: 0.7, y: 2.1, w: 5.6, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: C.sage, margin: 0 });
  s.addText(
    bullets([
      "Your calendar: a class, meeting or exam in progress",
      "Screen sharing and microphone use",
      "Quiet hours you set, and one-tap mute or snooze",
      "Your computer's Focus / Do Not Disturb (optional helper)",
      "Fullscreen and idle state",
    ], { color: C.bone, fontSize: 15, paraSpaceAfter: 9 }),
    { x: 0.7, y: 2.55, w: 6.0, h: 3.1, fontFace: FONT, valign: "top", margin: 0 }
  );

  s.addText("What you see", { x: 7.3, y: 2.1, w: 5.3, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: C.sage, margin: 0 });
  const states = [
    { t: "Listening", d: "Free: it may speak", c: C.sage },
    { t: "Idle", d: "Visual cues only", c: C.sand },
    { t: "Muted", d: "Silent: it holds what it has", c: C.danger },
  ];
  states.forEach((st, i) => {
    const y = 2.6 + i * 0.95;
    s.addShape(pptx.ShapeType.roundRect, { x: 7.3, y, w: 5.3, h: 0.8, rectRadius: 0.4, fill: { color: C.raised }, line: { color: C.edge, width: 1 } });
    s.addShape(pptx.ShapeType.ellipse, { x: 7.55, y: y + 0.27, w: 0.26, h: 0.26, fill: { color: st.c }, line: { color: st.c, width: 0 } });
    s.addText(st.t, { x: 8.0, y, w: 1.5, h: 0.8, fontFace: FONT, fontSize: 16, bold: true, color: C.bone, valign: "middle", margin: 0 });
    s.addText(st.d, { x: 9.5, y, w: 3.0, h: 0.8, fontFace: FONT, fontSize: 13, color: C.muted, valign: "middle", margin: 0 });
  });

  card(s, { x: 0.7, y: 5.5, w: 5.95, h: 1.25, accent: C.sand, titleSize: 15, bodySize: 13, title: "Exams stay exams", body: "If an exam and a meeting overlap, the exam rules win." });
  card(s, { x: 6.85, y: 5.5, w: 5.75, h: 1.25, accent: C.sand, titleSize: 15, bodySize: 13, title: "When in doubt, quiet", body: "If it cannot see your calendar, it assumes you might be busy." });
  s.addNotes(
    "Held alerts wait in the panel and play when you ask or when you are free. Two details worth saying out loud: " +
    "exams take priority over meetings because exam content is locked down, and offline it fails quiet, never loud. " +
    "Screen-share and mic detection was verified in a real browser; the Focus helper is optional and not yet packaged."
  );
}

/* ================= 5. capture ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "Capture", "From a photo to a calendar event, with you in charge.");
  const steps = [
    { n: "1", t: "Select", b: "Highlight text, or right-click an image, and choose Add to my calendar." },
    { n: "2", t: "It reads", b: "It extracts the event and flags anything it is unsure of, with its assumptions listed." },
    { n: "3", t: "You review", b: "Fill in any missing time yourself. Pick which calendar if you have two." },
    { n: "4", t: "You tap Add", b: "One event, exactly once. Double-taps cannot make a duplicate." },
  ];
  steps.forEach((st, i) => {
    const x = 0.7 + i * 3.04; // four 2.78in cards with 0.26in gaps end exactly on the 12.6in margin
    s.addShape(pptx.ShapeType.roundRect, { x, y: 2.3, w: 2.78, h: 3.0, rectRadius: 0.12, fill: { color: C.raised }, line: { color: C.edge, width: 1 } });
    s.addShape(pptx.ShapeType.ellipse, { x: x + 0.25, y: 2.55, w: 0.62, h: 0.62, fill: { color: C.sage }, line: { color: C.sage, width: 0 } });
    s.addText(st.n, { x: x + 0.25, y: 2.55, w: 0.62, h: 0.62, fontFace: FONT, fontSize: 20, bold: true, color: C.ground, align: "center", valign: "middle", margin: 0 });
    s.addText(st.t, { x: x + 0.25, y: 3.3, w: 2.3, h: 0.5, fontFace: FONT, fontSize: 19, bold: true, color: C.bone, margin: 0 });
    s.addText(st.b, { x: x + 0.25, y: 3.85, w: 2.35, h: 1.4, fontFace: FONT, fontSize: 13, color: C.muted, valign: "top", margin: 0 });
    if (i < steps.length - 1) {
      s.addShape(pptx.ShapeType.rightArrow, { x: x + 2.79, y: 3.6, w: 0.24, h: 0.34, fill: { color: C.faint }, line: { color: C.faint, width: 0 } });
    }
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 5.6, w: 11.9, h: 1.15, rectRadius: 0.12, fill: { color: C.surface }, line: { color: C.edge, width: 1 } });
  s.addText(
    [
      { text: "Blank beats a guess. ", options: { bold: true, color: C.sand } },
      { text: "It never invents an end time. Card and ID numbers are redacted before storage, instructions hidden inside an image are ignored, and a photo of a whole syllabus becomes many events.", options: { color: C.muted } },
    ],
    { x: 0.95, y: 5.6, w: 11.4, h: 1.15, fontFace: FONT, fontSize: 14, valign: "middle", margin: 0 }
  );
  s.addNotes(
    "The motivating failure: a flyer says 'Friday the 3rd, 7pm' with no year, zone or end time. A naive tool emits a confident timestamp and someone misses the recital. " +
    "This one emits the ambiguity. Be clear that the AI step is the part not yet proven against the live service; the review-and-confirm mechanics around it are tested."
  );
}

/* ================= you approve every event ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "Review", "You approve every event before it lands.");
  const pw = (4.7 * 760) / 1640;
  phone(s, "panel-suggestions.png", { x: 12.6 - pw - 0.06, caption: "Sample suggestions" });
  const x = 0.7, w = 8.8;
  point(s, { x, y: 1.95, w, n: 1, title: "It shows what it found, and what it is unsure of", body: "Each suggestion lists the time and place it read, flags anything worth checking, and states its assumptions." });
  point(s, { x, y: 3.45, w, n: 2, title: "A missing time stays blank, and asks you", body: "The concert had no end time on the flyer. It leaves the field empty and you fill it in. It never invents a duration." });
  point(s, { x, y: 4.95, w, n: 3, title: "You decide: Add or Dismiss", body: "Nothing is on your calendar until you tap Add to calendar, and a double tap cannot create a duplicate." });
  s.addNotes(
    "The middle suggestion is the point of the slide. A flyer said 7pm and nothing about an end time. Most tools would guess; this one asks. " +
    "The suggestions here are sample content fed to the real panel. If you have two calendars connected, the card also asks which one to use."
  );
}

/* ================= open and close apps ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "New: apps", "Open and close your apps, only when you ask.");
  phone(s, "panel-apps.png", { x: 0.95, caption: "Quick actions, listing apps on this Mac" });
  const x = 4.3, w = 8.3;
  point(s, { x, y: 1.95, w, n: 1, title: "Off until you turn it on", body: "It only touches the apps you tick in Settings, and the list of your apps never leaves your computer." });
  point(s, { x, y: 3.3, w, n: 2, title: "Open is instant. Close asks first.", body: "Closing is a polite request, never a force-quit, so an app can still ask you to save." });
  point(s, { x, y: 4.65, w, n: 3, title: "Some apps can never be closed", body: "Your browser, Finder and system apps can be opened but never closed from here, which is why Chrome's Close button is greyed out." });
  s.addText("macOS only today. Opening is verified with a real app. A real close needs a one-time macOS permission and has not been run yet.", {
    x, y: 6.15, w, h: 0.55, fontFace: FONT, fontSize: 12, italic: true, color: C.sand, valign: "top", margin: 0,
  });
  s.addNotes(
    "Typed commands like 'open Zoom' are read by plain matching, with no AI involved, and only you can trigger them from the panel. " +
    "A web page, a calendar entry or a photo cannot. Be honest about status: opening was tested with a real app; a real close was not run, because macOS shows a one-time permission prompt. " +
    "It needs a small helper installed on the Mac, kept separate so it can be added or removed on its own."
  );
}

/* ================= 6. trust ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "Trust", "Built in, not promised.");
  const items = [
    ["AI is opt-in", "Captured text and images go to Anthropic only if you turn it on. Off takes effect on the next request."],
    ["Delete everything", "One step removes your data from the server and the device, and revokes Google access."],
    ["Learning is off by default", "If on, it learns timing only, never titles or people. Switching off destroys it."],
    ["Writes need a tap", "The database rejects an event record that was never confirmed."],
    ["Secrets stay off the device", "Sign-in uses a standard secure flow. Calendar tokens are encrypted at rest on the server."],
    ["Sensitive messages first", "Crisis language is intercepted before any AI sees it, and logged without its content."],
  ];
  items.forEach(([t, b], i) => {
    const col = i % 3, row = Math.floor(i / 3);
    card(s, { x: 0.7 + col * 4.025, y: 2.15 + row * 2.2, w: 3.85, h: 2.0, title: t, body: b, titleSize: 16, bodySize: 13 });
  });
  s.addText("The rules are enforced by the database and the code, not by good intentions.", {
    x: 0.7, y: 6.6, w: 11.9, h: 0.35, fontFace: FONT, fontSize: 14, italic: true, color: C.sand, margin: 0,
  });
  s.addNotes(
    "Be precise here. Tokens are encrypted at rest on our server; that is NOT end-to-end encryption and we should never describe it that way. " +
    "Captured content does go to Anthropic if the user opts in, so we cannot claim nothing leaves the device. " +
    "The crisis handling is a safety net, not a mental-health product. All of these controls are covered by automated tests."
  );
}

/* ================= 7. audience ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "Who it is for", "People whose attention is the scarce thing.");
  const W = 5.85, H = 2.0;
  card(s, { x: 0.7, y: 2.2, w: W, h: H, title: "Students", body: "Quiet in lectures and exams. Photos of syllabi, whiteboards and flyers become events they review first." });
  card(s, { x: 6.75, y: 2.2, w: W, h: H, title: "Presenters and call-heavy roles", body: "Teachers, trainers, streamers. It will not speak over you while you share your screen." });
  card(s, { x: 0.7, y: 4.4, w: W, h: H, title: "Busy professionals", body: "A day of back-to-back meetings, with quiet where it counts and a held queue for later." });
  card(s, { x: 6.75, y: 4.4, w: W, h: H, title: "Parents and organizers", body: "The school flyer or event photo becomes a calendar entry in a couple of taps, with doubts flagged." });
  s.addNotes(
    "Students are the sharpest wedge: exam awareness and syllabus capture are things generic schedulers do not do, and the privacy posture suits them. " +
    "Professionals are a larger market but more crowded. I would like the group's view on which to lead with."
  );
}

/* ================= 8. landscape table ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "The landscape", "A different job from the tools around us.");
  const hdr = (t, color = C.bone) => ({ text: t, options: { bold: true, color, fill: { color: C.surface }, fontSize: 13, fontFace: FONT, valign: "middle" } });
  const cell = (t, o = {}) => ({ text: t, options: { color: C.muted, fill: { color: C.raised }, fontSize: 12, fontFace: FONT, valign: "middle", ...o } });
  const us = (t) => cell(t, { color: C.bone, bold: true, fill: { color: "26302F" } });
  const rows = [
    [hdr(""), hdr("Auto-schedulers\n(e.g. Motion, Reclaim)"), hdr("Photo-to-calendar apps"), hdr("Ambient Cyber Companion", C.sage)],
    [cell("Core job", { bold: true, color: C.bone }), cell("Plan tasks and protect time automatically"), cell("Read an image into an event"), us("Know when to speak, and capture events safely")],
    [cell("Who decides when it acts", { bold: true, color: C.bone }), cell("The tool"), cell("You"), us("You, after it reads your context")],
    [cell("Knows you are in a meeting, exam, or sharing", { bold: true, color: C.bone }), cell("Not its focus"), cell("No"), us("Yes, and goes quiet")],
    [cell("Writes to your calendar", { bold: true, color: C.bone }), cell("Adjusts and reschedules automatically"), cell("Often saves directly, usually with a review step"), us("Only after your explicit tap")],
    [cell("Admits when unsure", { bold: true, color: C.bone }), cell("Not its focus"), cell("Varies"), us("Per-field confidence; blank beats a guess")],
  ];
  s.addTable(rows, {
    x: 0.7, y: 2.05, w: 11.9, colW: [2.9, 2.95, 2.95, 3.1], rowH: [0.7, 0.62, 0.62, 0.72, 0.72, 0.62],
    border: { type: "solid", pt: 1, color: C.edge }, margin: [0.05, 0.12, 0.05, 0.12],
  });
  s.addText("Competitor descriptions come from public comparison articles, several by competing vendors. Verify before using externally.", {
    x: 0.7, y: 6.45, w: 11.9, h: 0.35, fontFace: FONT, fontSize: 11, italic: true, color: C.faint, margin: 0,
  });
  s.addNotes(
    "The point is not that the others are bad. Auto-schedulers optimise your plan; photo apps extract events. Neither is built around 'should I be speaking right now' or around a never-without-a-tap rule. " +
    "One caution: these descriptions come from comparison articles, many written by competing vendors, so we should check each vendor's own pages before putting a comparison in public. " +
    "Also note that Clockwise, a known tool in this space, was reported to have shut down in March 2026."
  );
}

/* ================= 9. what sets us apart ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "What sets us apart", "Five ideas the others are not built around.");
  const pts = [
    ["Context before action", "Most assistants optimise your schedule. This one first asks whether it should be speaking at all."],
    ["Consent as a mechanism", "The tap rule, the learning toggle and the AI switch are enforced by the system itself."],
    ["Honest about uncertainty", "A blank field instead of a confident wrong answer."],
    ["Safe with sensitive input", "Crisis messages intercepted first, secrets redacted, hidden instructions ignored."],
    ["Private and deletable", "Learned patterns are timing only, and users can erase everything themselves."],
  ];
  pts.forEach(([t, b], i) => {
    const y = 2.1 + i * 0.93;
    s.addShape(pptx.ShapeType.roundRect, { x: 0.7, y, w: 11.9, h: 0.82, rectRadius: 0.1, fill: { color: C.raised }, line: { color: C.edge, width: 1 } });
    s.addText(String(i + 1), { x: 0.95, y, w: 0.5, h: 0.82, fontFace: FONT, fontSize: 24, bold: true, color: C.sand, valign: "middle", margin: 0 });
    s.addText(t, { x: 1.55, y, w: 3.9, h: 0.82, fontFace: FONT, fontSize: 16, bold: true, color: C.bone, valign: "middle", margin: 0 });
    s.addText(b, { x: 5.5, y, w: 6.9, h: 0.82, fontFace: FONT, fontSize: 13, color: C.muted, valign: "middle", margin: 0 });
  });
  s.addNotes(
    "These are design positions, not features a competitor could not copy. The defensible part is the combination and the discipline of enforcing it in the system, " +
    "which is also what makes the product easier to trust. None of this has yet been proven with real users, which the next slide is straight about."
  );
}

/* ================= 10. where we are ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "Where we are today", "An honest account of what is real.");
  const colW = 3.85, y = 2.1, h = 4.3;
  const col = (i, color, label, items, foot) => {
    const x = 0.7 + i * 4.025;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: colW, h, rectRadius: 0.12, fill: { color: C.raised }, line: { color, width: 1.5 } });
    s.addShape(pptx.ShapeType.ellipse, { x: x + 0.3, y: y + 0.3, w: 0.24, h: 0.24, fill: { color }, line: { color, width: 0 } });
    s.addText(label, { x: x + 0.7, y: y + 0.2, w: colW - 0.9, h: 0.44, fontFace: FONT, fontSize: 16, bold: true, color: C.bone, valign: "middle", margin: 0 });
    s.addText(bullets(items, { color: C.muted, fontSize: 13, paraSpaceAfter: 6 }), { x: x + 0.3, y: y + 0.85, w: colW - 0.55, h: h - (foot ? 1.85 : 1.0), fontFace: FONT, valign: "top", margin: 0 });
    if (foot) s.addText(foot, { x: x + 0.3, y: y + h - 0.95, w: colW - 0.55, h: 0.8, fontFace: FONT, fontSize: 12, bold: true, color, valign: "bottom", margin: 0 });
  };
  col(0, C.sage, "Built and tested", [
    "Quiet mode, mute and snooze",
    "Screen-share and mic detection (real browser)",
    "Suggested events: review and add",
    "Add-once logic, sync, reconnecting",
    "Privacy rules enforced by the database",
    "Opening apps from the panel (macOS)",
  ], "230+ automated tests · 3 browser suites · 0 known vulnerabilities");
  col(1, C.sand, "Not yet proven live", [
    "Google and Microsoft sign-in and event creation",
    "The AI prompts on the live service",
    "A hosted database (tested on an in-process one)",
    "Closing an app for real (macOS asks for permission first)",
    "Real users and real load",
  ], "Works against fakes. Real-world run is the next step.");
  col(2, C.danger, "Designed, not switched on", [
    "Adaptive learning (toggle and privacy rules are done)",
    "Prep cards for upcoming events",
    "Canvas and Blackboard calendar feeds",
    "OS Focus helper packaging",
    "Enterprise admin screen",
  ], "Not to be advertised as working.");
  s.addNotes(
    "I would rather say this plainly than have a partner find out later. The left column is verified by tests and browser checks. " +
    "The middle column is code that is written and exercised against fakes, but has not touched Google, Microsoft, the live AI service or a hosted database. " +
    "The right column exists in design or partly in code but is not operating end to end, so it must not appear in any marketing. " +
    "One new item: the extension can now open and close apps you allow, on macOS, only when you ask. Opening has been tried with a real app. " +
    "Closing asks for confirmation and is a polite quit, never a force-quit, but a real close has not been run because macOS shows a one-time permission prompt, so do not promise it yet."
  );
}

/* ================= 11. launch plan ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "The path to launch", "Four steps from here to a product people can buy.");
  const phases = [
    { t: "1  Verify", b: "Run against real Google, Microsoft, the live AI service and a hosted database. Fix what breaks.", c: C.sage },
    { t: "2  Closed beta", b: "Students and presenters use it for real. Measure whether the quiet mode earns its place.", c: C.sage },
    { t: "3  Launch", b: "Store listings, privacy policy, pricing live, Google's review for calendar access.", c: C.sand },
    { t: "4  Expand", b: "Switch on learning and prep cards, add Canvas and Blackboard feeds, then organizations.", c: C.faint },
  ];
  phases.forEach((p, i) => {
    const x = 0.7 + i * 3.04; // ends exactly on the 12.6in margin
    s.addShape(pptx.ShapeType.roundRect, { x, y: 2.2, w: 2.78, h: 2.5, rectRadius: 0.12, fill: { color: C.raised }, line: { color: p.c, width: 1.5 } });
    s.addText(p.t, { x: x + 0.25, y: 2.35, w: 2.4, h: 0.55, fontFace: FONT, fontSize: 18, bold: true, color: C.bone, valign: "middle", margin: 0 });
    s.addText(p.b, { x: x + 0.25, y: 3.0, w: 2.4, h: 1.6, fontFace: FONT, fontSize: 13, color: C.muted, valign: "top", margin: 0 });
  });
  s.addText("Things that could slow us down", { x: 0.7, y: 4.95, w: 11.9, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: C.sage, margin: 0 });
  s.addText(
    bullets([
      "Google's verification process for apps that read calendars: timing is outside our control, and the exact requirements need confirming.",
      "Cost per use: each capture is a paid AI call, so pricing has to cover it.",
      "A crowded category: we win on trust and context, not on features alone.",
    ], { color: C.muted, fontSize: 13, paraSpaceAfter: 6 }),
    { x: 0.7, y: 5.4, w: 11.9, h: 1.5, fontFace: FONT, valign: "top", margin: 0 }
  );
  s.addNotes(
    "I have deliberately not put dates or numbers on these steps because I do not yet have a basis for them; step one will tell us. " +
    "Google's review is a known gate for calendar access and I want to confirm its requirements before promising a timeline. " +
    "The per-capture AI cost is the main driver of the pricing decision on the next slide."
  );
}

/* ================= business model ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "Business model", "Three ways to charge, and what each would mean.");
  const hdr = (t) => ({ text: t, options: { bold: true, color: C.sage, fill: { color: C.surface }, fontSize: 14, fontFace: FONT, valign: "middle" } });
  const lab = (t) => ({ text: t, options: { bold: true, color: C.bone, fill: { color: C.raised }, fontSize: 12, fontFace: FONT, valign: "middle" } });
  const cell = (t) => ({ text: t, options: { color: C.muted, fill: { color: C.raised }, fontSize: 12, fontFace: FONT, valign: "middle" } });
  const rows = [
    [hdr(""), hdr("Subscription"), hdr("One-time purchase"), hdr("Organization licence")],
    [lab("Why it could work"), cell("Matches an ongoing cost: every capture is a paid AI call"), cell("Simple, and easy to say yes to"), cell("Schools and teams buy for many people at once")],
    [lab("Main risk"), cell("Needs a reason to keep paying; students are price-sensitive"), cell("AI cost continues after the sale, so heavy users erode the margin"), cell("Longer sales, and it needs an admin screen and security review we do not have yet")],
    [lab("Best suited to"), cell("Individuals and students"), cell("People who dislike subscriptions"), cell("Schools and companies")],
    [lab("What it needs first"), cell("A clear monthly value, plus a usage limit"), cell("A usage cap, or a way to cover the AI cost"), cell("Admin controls and an audit view")],
  ];
  s.addTable(rows, {
    x: 0.7, y: 2.05, w: 11.9, colW: [2.3, 3.2, 3.2, 3.2], rowH: [0.6, 0.85, 1.05, 0.7, 0.85],
    border: { type: "solid", pt: 1, color: C.edge }, margin: [0.06, 0.14, 0.06, 0.14],
  });
  s.addText("No prices yet, on purpose. The verification phase measures the real cost per capture, and we price against that.", {
    x: 0.7, y: 6.35, w: 11.9, h: 0.4, fontFace: FONT, fontSize: 14, italic: true, color: C.sand, margin: 0,
  });
  s.addNotes(
    "I have not put numbers on this because I do not have a basis for them yet. The cost that matters is each capture being a paid AI call: that cost never stops, which is why a one-time price is the riskiest option and a subscription with a usage limit is the most natural fit. " +
    "Organization licences are attractive but need an admin screen that does not exist yet; the controls are in the database, but there is no screen for them. This feeds directly into decision two on the next slide."
  );
}

/* ================= 12. decisions ================= */
{
  const s = pptx.addSlide({ masterName: "MAIN" });
  head(s, "What I need from you", "Four decisions to move forward.");
  const items = [
    ["Lead audience", "Students first (sharpest wedge, privacy suits them) or professionals first (bigger, more crowded)?"],
    ["Business model", "Subscription, one-time purchase, or organization licences? Per-use AI cost favours a subscription or a usage cap."],
    ["Browsers first", "Chrome and Edge are the tested path. Firefox and Safari can follow. Agree?"],
    ["Go and resourcing", "Approve the verification phase and agree who owns accounts for Google, Microsoft, hosting and the AI service."],
  ];
  items.forEach(([t, b], i) => {
    const y = 2.15 + i * 1.07;
    s.addShape(pptx.ShapeType.roundRect, { x: 0.7, y, w: 11.9, h: 0.94, rectRadius: 0.1, fill: { color: C.raised }, line: { color: C.edge, width: 1 } });
    s.addShape(pptx.ShapeType.ellipse, { x: 0.95, y: y + 0.25, w: 0.44, h: 0.44, fill: { color: C.sand }, line: { color: C.sand, width: 0 } });
    s.addText(String(i + 1), { x: 0.95, y: y + 0.25, w: 0.44, h: 0.44, fontFace: FONT, fontSize: 16, bold: true, color: C.ground, align: "center", valign: "middle", margin: 0 });
    s.addText(t, { x: 1.65, y, w: 2.9, h: 0.94, fontFace: FONT, fontSize: 16, bold: true, color: C.bone, valign: "middle", margin: 0 });
    s.addText(b, { x: 4.6, y, w: 7.85, h: 0.94, fontFace: FONT, fontSize: 13, color: C.muted, valign: "middle", margin: 0 });
  });
  s.addText("An assistant that earns your attention by knowing when to stay quiet.", {
    x: 0.7, y: 6.6, w: 11.9, h: 0.35, fontFace: FONT, fontSize: 15, italic: true, color: C.sage, margin: 0,
  });
  s.addNotes(
    "Close by asking for the decisions, not applause. The first two shape everything downstream: who we build for and how we charge. " +
    "I have left pricing numbers out on purpose; I would rather decide the model with you and then size the number against real AI cost from the verification phase."
  );
}

await pptx.writeFile({ fileName: out });
console.log(`wrote ${out}`);

if (RECORD) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(RECORD, JSON.stringify({ palette: C, font: FONT, slides: recorded }));
  console.log(`recorded ${recorded.length} slides to ${RECORD}`);
}
