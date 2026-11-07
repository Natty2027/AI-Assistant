/**
 * Renders the deck's recorded slides to PNGs in Chromium, as a layout check.   npm run deck:preview
 *
 * It replays the same coordinates, sizes, colours and text that went into the .pptx, at the same
 * 13.33 x 7.5 in proportions, so overflow, overlap and clipping show up. It is a close proxy, not
 * PowerPoint itself: text metrics differ slightly between renderers, so leave a little slack.
 *
 * Output: deck/preview/NN.png and deck/preview/contact-sheet.png
 */
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const json = path.join(here, "preview", "slides.json");
await rm(path.join(here, "preview"), { recursive: true, force: true });
await mkdir(path.join(here, "preview"), { recursive: true });

const built = spawnSync("node", [path.join(here, "build-deck.mjs")], { env: { ...process.env, DECK_RECORD: json }, encoding: "utf8" });
if (built.status !== 0) { console.error(built.stderr || built.stdout); process.exit(1); }
const { palette: P, font, slides } = JSON.parse(await readFile(json, "utf8"));

const PX = 96;                       // CSS pixels per inch
const px = (inches) => `${(inches * PX).toFixed(2)}px`;
const pt = (n) => `${(n * PX / 72).toFixed(2)}px`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hex = (c) => (c ? `#${c}` : "transparent");

function lineCss(line) {
  if (!line || !line.width || line.width <= 0) return "border:0;";
  return `border:${pt(line.width)} solid ${hex(line.color)};`;
}

function textHtml(text, o) {
  const runs = Array.isArray(text) ? text : [{ text, options: {} }];
  // Group runs into paragraphs: a run with breakLine ends its paragraph.
  const paras = [];
  let cur = [];
  for (const r of runs) {
    cur.push(r);
    if (r.options?.breakLine) { paras.push(cur); cur = []; }
  }
  if (cur.length) paras.push(cur);

  return paras.map((para) => {
    const first = para[0].options ?? {};
    const space = first.paraSpaceAfter ?? o.paraSpaceAfter ?? 0;
    const bullet = first.bullet ? "padding-left:1.1em;text-indent:-1.1em;" : "";
    const inner = para.map((r) => {
      const ro = { ...o, ...(r.options ?? {}) };
      const style = [
        ro.bold ? "font-weight:700" : "", ro.italic ? "font-style:italic" : "",
        ro.color ? `color:${hex(ro.color)}` : "", ro.fontSize ? `font-size:${pt(ro.fontSize)}` : "",
      ].filter(Boolean).join(";");
      const lead = r.options?.bullet ? "●&nbsp;&nbsp;" : "";
      return `<span style="${style}">${lead}${esc(r.text).replace(/\n/g, "<br>")}</span>`;
    }).join("");
    return `<div style="margin-bottom:${pt(space)};${bullet}">${inner}</div>`;
  }).join("");
}

function render(op) {
  const [a0, a1] = op.args;
  if (op.k === "addImage") {
    // setContent pages cannot load file:// URLs, so inline the picture.
    const data = readFileSync(a0.path).toString("base64");
    return `<img src="data:image/png;base64,${data}" style="position:absolute;left:${px(a0.x)};top:${px(a0.y)};width:${px(a0.w)};height:${px(a0.h)}">`;
  }
  if (op.k === "addText") {
    const o = a1 ?? {};
    const m = o.margin === undefined ? 0.1 : Array.isArray(o.margin) ? null : o.margin;
    const pad = m === null ? o.margin.map((v) => px(v)).join(" ") : px(m);
    const justify = { top: "flex-start", middle: "center", bottom: "flex-end" }[o.valign ?? "top"];
    return `<div class="t" style="left:${px(o.x)};top:${px(o.y)};width:${px(o.w)};height:${px(o.h)};padding:${pad};
      justify-content:${justify};text-align:${o.align ?? "left"};font-family:${o.fontFace ?? font},Helvetica,sans-serif;
      font-size:${pt(o.fontSize ?? 18)};color:${hex(o.color ?? "000000")};${o.bold ? "font-weight:700;" : ""}${o.italic ? "font-style:italic;" : ""}
      ${o.charSpacing ? `letter-spacing:${pt(o.charSpacing)};` : ""}">${textHtml(a0, o)}</div>`;
  }
  if (op.k === "addShape") {
    const o = a1 ?? {};
    const base = `left:${px(o.x)};top:${px(o.y)};width:${px(o.w)};height:${px(o.h)};background:${hex(o.fill?.color)};${lineCss(o.line)}`;
    if (a0 === "ellipse") return `<div class="s" style="${base}border-radius:50%"></div>`;
    if (a0 === "roundRect") return `<div class="s" style="${base}border-radius:${px(o.rectRadius ?? 0)}"></div>`;
    if (a0 === "rightArrow") return `<div class="s" style="${base}border:0;clip-path:polygon(0 25%,60% 25%,60% 0,100% 50%,60% 100%,60% 75%,0 75%)"></div>`;
    return `<div class="s" style="${base}"></div>`;
  }
  if (op.k === "addTable") {
    const rows = a0;
    // pptxgenjs rewrites a table's position and widths into EMU (914400 per inch) after the call,
    // while the row heights stay in inches. Normalise so both draw at the size that was meant.
    const inch = (v) => (v > 1000 ? v / 914400 : v);
    const o = { ...a1, x: inch(a1.x), y: inch(a1.y), w: inch(a1.w), colW: a1.colW.map(inch), rowH: a1.rowH.map(inch) };
    const m = o.margin ?? [0.05, 0.1, 0.05, 0.1];
    const body = rows.map((row, ri) => `<tr style="height:${px(o.rowH[ri])}">${row.map((c, ci) => {
      const co = c.options ?? {};
      return `<td style="width:${px(o.colW[ci])};background:${hex(co.fill?.color)};color:${hex(co.color)};font-size:${pt(co.fontSize ?? 12)};
        font-weight:${co.bold ? 700 : 400};font-family:${co.fontFace ?? font},Helvetica,sans-serif;vertical-align:${co.valign ?? "middle"};
        padding:${px(m[0])} ${px(m[1])} ${px(m[2])} ${px(m[3])};border:${pt(o.border.pt)} solid ${hex(o.border.color)}">${esc(c.text).replace(/\n/g, "<br>")}</td>`;
    }).join("")}</tr>`).join("");
    return `<table class="tbl" style="left:${px(o.x)};top:${px(o.y)};width:${px(o.w)}">${body}</table>`;
  }
  return "";
}

const html = (i, s) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#000}
  .slide{position:relative;width:${px(13.333)};height:${px(7.5)};background:#${P.ground};overflow:hidden}
  .t{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;line-height:1.2;overflow:visible}
  .s{position:absolute;box-sizing:border-box}
  .tbl{position:absolute;border-collapse:collapse;table-layout:fixed}
  .tbl td{box-sizing:border-box;overflow:hidden;line-height:1.2}
</style><div class="slide">${s.ops.map(render).join("")}
  ${s.master === "MAIN" ? `<div class="t" style="left:${px(0.7)};top:${px(7.02)};width:${px(7)};height:${px(0.3)};padding:${px(0.1)};justify-content:center;font-family:${font};font-size:${pt(10)};color:#${P.faint}">Ambient Cyber Companion  ·  Partner briefing</div>
  <div class="t" style="left:${px(12.1)};top:${px(7.02)};width:${px(0.6)};height:${px(0.3)};padding:${px(0.1)};justify-content:center;text-align:right;font-family:${font};font-size:${pt(10)};color:#${P.faint}">${i + 1}</div>` : ""}
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const { writeFile } = await import("node:fs/promises");
for (let i = 0; i < slides.length; i++) {
  const markup = html(i, slides[i]);
  await writeFile(path.join(here, "preview", `${String(i + 1).padStart(2, "0")}.html`), markup);
  await page.setContent(markup);
  await page.screenshot({ path: path.join(here, "preview", `${String(i + 1).padStart(2, "0")}.png`) });
}

// A text box whose content is taller than its box means the text will spill out of it.
await page.setContent("<body></body>");
const overflow = [];
for (let i = 0; i < slides.length; i++) {
  await page.setContent(html(i, slides[i]));
  const hits = await page.evaluate(() =>
    [...document.querySelectorAll(".t")].filter((el) => el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)
      .map((el) => ({ text: el.textContent.trim().slice(0, 50), over: el.scrollHeight - el.clientHeight })));
  hits.forEach((h) => overflow.push({ slide: i + 1, ...h }));
}
await browser.close();

console.log(`rendered ${slides.length} slides to deck/preview/`);
if (overflow.length) {
  console.log("TEXT OVERFLOWS ITS BOX:");
  overflow.forEach((o) => console.log(`  slide ${o.slide}: "${o.text}" (+${o.over}px)`));
  process.exit(1);
}
console.log("no text overflows its box");
