/**
 * Side panel logic. Moved out of an inline <script> because MV3's CSP (script-src 'self')
 * blocks inline scripts outright — the panel's automation toggle silently never ran in the
 * real extension before this file existed.
 *
 * Renders live state via the "panel:hello" / "quiet:update" / "alerts:held" contract in
 * sw.ts. Outside the extension (or with ?demo in the URL), it renders built-in sample data
 * instead, so the HTML still previews standalone in a browser tab.
 */

import { initAppearance } from "./appearance";
import { fromLocalInput } from "./localTime";
import { loadAppControl } from "./state";
import { describeError } from "../apps/appControl";
import { parseAppCommand, type AppInfo, type Verb } from "../apps/commands";

interface Suggestion {
  id: string; title: string; start: string | null; end: string | null; all_day: boolean;
  location: string | null; needs_review: string[]; assumptions: string[];
}

type QuietLevel = "full" | "visual_only" | "silent";
interface Verdict { level: QuietLevel; reason: string }
interface PanelEvent { title: string; category: string; start: string; end: string; location?: string | null }
interface PanelAlert { id: string; text: string; scheduledFor: string }

const ext = typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime : null;
const DEMO = !ext || new URLSearchParams(location.search).has("demo");

function send(msg: Record<string, unknown>): Promise<any> {
  if (!ext) return Promise.resolve(null);
  return new Promise((resolve) => ext.sendMessage(msg, (res: unknown) => resolve(res)));
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** For values placed inside an HTML attribute. escapeHtml() above is NOT enough here: setting
 *  textContent and reading innerHTML leaves quotes alone, so a value containing `"` would end
 *  the attribute and let the rest be parsed as markup. Alert ids are built from event titles,
 *  which anyone who can invite the user to an event controls. */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const CATEGORY_LABEL: Record<string, string> = {
  exam: "Exam", class: "Class", meeting: "Meeting", assignment: "Due", focus_block: "Focus",
};

/* ---------------- header: presence + quiet reason ---------------- */

const STATE_LABEL: Record<QuietLevel, string> = { full: "Listening", visual_only: "Idle", silent: "Muted" };
const PRESENCE_STATE: Record<QuietLevel, string> = { full: "listening", visual_only: "idle", silent: "muted" };

function renderVerdict(verdict: Verdict): void {
  document.body.dataset.state = PRESENCE_STATE[verdict.level] ?? "idle";
  document.body.dataset.quiet = verdict.level === "silent" ? "silent" : "active";
  el("stateLabel").textContent = STATE_LABEL[verdict.level] ?? "Idle";
  el("quietReason").textContent = verdict.reason ?? "";
}

/* ---------------- day header ---------------- */

function renderDayHeader(events: PanelEvent[]): void {
  const now = new Date();
  el("dayHeading").textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const upcoming = events.filter((e) => new Date(e.end) > now).length;
  el("daySummary").textContent = events.length
    ? `${upcoming} ${upcoming === 1 ? "event" : "events"} left today`
    : "Nothing on the calendar yet";
}

/* ---------------- timeline ---------------- */

function renderTimeline(events: PanelEvent[]): void {
  const gutter = el<HTMLDivElement>("timelineGutter");
  if (!events.length) {
    gutter.className = "empty";
    gutter.innerHTML = `
      <span class="text-sm">No calendar connected yet</span>
      <span class="text-xs text-faint">Connect Google or Outlook to see your day here.</span>
      <a class="btn btn-primary btn-sm cta" href="connect-disclosure.html?provider=google">Connect a calendar</a>
    `;
    return;
  }
  gutter.className = "gutter";
  const now = new Date();
  gutter.innerHTML = events.map((ev) => {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    const isNow = start <= now && end > now;
    const pct = isNow
      ? Math.min(100, Math.max(0, ((now.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * 100))
      : 0;
    return `
      <div class="tick${isNow ? " tick-now" : ""}">
        <div class="time${isNow ? " text-sand" : ""}">${fmtTime(start)}${isNow ? " · now" : ""}</div>
        <div class="text-sm${isNow ? "" : " text-muted"}" style="display:flex;align-items:center;gap:6px;margin-top:2px">
          <span class="chip chip-${Object.hasOwn(CATEGORY_LABEL, ev.category) ? ev.category : "other"}">${CATEGORY_LABEL[ev.category] ?? "Event"}</span>
          <span>${escapeHtml(ev.title)}</span>
        </div>
        ${ev.location ? `<div class="text-xs text-muted">${escapeHtml(ev.location)}</div>` : ""}
        ${isNow ? `<div class="now-progress"><span style="width:${pct}%"></span></div>` : ""}
      </div>
    `;
  }).join("");
}

/* ---------------- prep card — honest empty state; the real audit needs a backend ---------------- */

function renderPrep(hasEvents: boolean): void {
  el("prepSection").innerHTML = hasEvents
    ? `<div class="empty">
         <span class="text-sm">Prep for your next event needs a connected calendar and AI access</span>
         <span class="text-xs text-faint">Once connected, requirements found in the event notes show up here.</span>
       </div>`
    : "";
}

/* ---------------- held alerts ---------------- */

function renderHeld(alerts: PanelAlert[]): void {
  const list = el<HTMLDivElement>("heldList");
  el<HTMLButtonElement>("flushBtn").hidden = alerts.length === 0;
  if (!alerts.length) {
    list.innerHTML = `<div class="empty"><span class="text-sm">All clear — nothing held right now</span></div>`;
    return;
  }
  list.innerHTML = alerts.map((a) => `
    <div class="card held-item">
      <div>
        <div class="text-sm">${escapeHtml(a.text)}</div>
        <div class="text-xs text-faint" style="margin-top:3px">Would have chimed at ${fmtTime(new Date(a.scheduledFor))}</div>
      </div>
      <button type="button" data-dismiss="${escapeAttr(a.id)}" aria-label="Dismiss">✕</button>
    </div>
  `).join("");
}

/* ---------------- automation toggle ---------------- */

function renderAutomation(enabled: boolean, synced = true): void {
  el("automationToggle").setAttribute("aria-checked", String(enabled));
  el("syncNote").textContent = synced ? "" : "Saved on this device — couldn't reach the server.";
}

/* ---------------- mute / snooze ---------------- */

function renderMute(mutedUntil: Date | null): void {
  el<HTMLButtonElement>("unmuteOption").hidden = !mutedUntil;
}

/* ---------------- toast (capture proposals) ---------------- */

let toastTimer = 0;
function showToast(text: string, ms = 6000): void {
  const t = el<HTMLDivElement>("toast");
  t.textContent = text;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------------- suggested events: nothing is on a calendar until the user taps Add ---------------- */

const REVIEW_LABEL: Record<string, string> = {
  title: "the title", start_time: "the start time", end_time: "the end time", location: "the location",
  _image_legibility: "the photo was hard to read",
};

function describeWhen(s: Suggestion): string {
  if (!s.start) return "No start time was found";
  const start = new Date(s.start);
  if (s.all_day) return start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const day = start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const end = s.end ? ` – ${fmtTime(new Date(s.end))}` : "";
  return `${day}, ${fmtTime(start)}${end}`;
}

function renderSuggestions(items: Suggestion[]): void {
  el("suggestSection").hidden = items.length === 0;
  el("suggestList").innerHTML = items.map((s) => {
    const needsStart = !s.start;
    const needsEnd = !s.all_day && !s.end;
    const check = s.needs_review.map((f) => REVIEW_LABEL[f] ?? f.replace(/_/g, " "));
    return `
      <div class="card suggest-card" data-id="${escapeAttr(s.id)}">
        <div class="text-sm">${escapeHtml(s.title)}</div>
        <div class="text-xs text-muted">${escapeHtml(describeWhen(s))}</div>
        ${s.location ? `<div class="text-xs text-muted">${escapeHtml(s.location)}</div>` : ""}
        ${check.length ? `<div class="text-xs text-sand">Worth checking: ${escapeHtml(check.join(", "))}</div>` : ""}
        ${s.assumptions.slice(0, 3).map((a) => `<div class="text-xs text-faint">${escapeHtml(a)}</div>`).join("")}
        ${needsStart ? `<label class="text-xs">Starts<input type="datetime-local" data-start></label>` : ""}
        ${needsEnd ? `<label class="text-xs">Ends<input type="datetime-local" data-end></label>` : ""}
        <p class="text-xs text-sand suggest-note" role="status" data-note></p>
        <div class="suggest-actions">
          <button type="button" class="btn btn-primary btn-sm" data-add>Add to calendar</button>
          <button type="button" class="btn btn-ghost btn-sm" data-reject>Dismiss</button>
        </div>
        <div class="suggest-actions" data-choice hidden>
          <button type="button" class="btn btn-sm" data-provider="google">Google Calendar</button>
          <button type="button" class="btn btn-sm" data-provider="microsoft">Outlook</button>
        </div>
      </div>`;
  }).join("");
}

async function loadSuggestions(): Promise<void> {
  const res = await send({ type: "proposals:list" });
  if (res?.ok) renderSuggestions(res.proposals as Suggestion[]);
}

function dropCard(card: HTMLElement): void {
  card.remove();
  if (!el("suggestList").querySelector(".suggest-card")) el("suggestSection").hidden = true;
}

async function confirmSuggestion(card: HTMLElement, provider?: string): Promise<void> {
  const note = card.querySelector<HTMLElement>("[data-note]")!;
  const startIn = card.querySelector<HTMLInputElement>("[data-start]");
  const endIn = card.querySelector<HTMLInputElement>("[data-end]");

  // The assistant never guesses a missing time, so the user must supply it here.
  const start = startIn ? fromLocalInput(startIn.value) : undefined;
  const end = endIn ? fromLocalInput(endIn.value) : undefined;
  if (startIn && !start) { note.textContent = "Pick a start time first."; startIn.focus(); return; }
  if (endIn && !end) { note.textContent = "Pick an end time first."; endIn.focus(); return; }

  const buttons = card.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((b) => (b.disabled = true)); // a double tap must not send two requests
  note.textContent = "Adding…";

  const res = await send({ type: "proposal:confirm", id: card.dataset.id, start, end, provider });
  if (res?.ok) {
    showToast("Added to your calendar. Please check it looks right.");
    dropCard(card);
    return;
  }
  buttons.forEach((b) => (b.disabled = false));
  if (res?.code === "choose_calendar") card.querySelector<HTMLElement>("[data-choice]")!.hidden = false;
  note.textContent = res?.error ?? "Couldn't reach the server. Nothing was added.";
}

function wireSuggestions(): void {
  el<HTMLDivElement>("suggestList").addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    const card = btn?.closest(".suggest-card") as HTMLElement | null;
    if (!btn || !card) return;
    if (btn.hasAttribute("data-add")) await confirmSuggestion(card);
    else if (btn.dataset.provider) await confirmSuggestion(card, btn.dataset.provider);
    else if (btn.hasAttribute("data-reject")) {
      btn.disabled = true;
      await send({ type: "proposal:reject", id: card.dataset.id });
      dropCard(card);
    }
  });
}

/* ---------------- quick actions: open and close apps the user has allowed ---------------- */

let allowedApps: AppInfo[] = [];

function appsNote(text: string): void { el("appsNote").textContent = text; }

/** Built with DOM calls: an app's name is whatever its folder is called on disk. */
function renderApps(): void {
  const rows = el<HTMLDivElement>("appsRows");
  el("appsSection").hidden = allowedApps.length === 0;
  rows.replaceChildren(...allowedApps.map((app) => {
    const row = document.createElement("div");
    row.className = "app-row";
    row.dataset.id = app.id;

    const dot = document.createElement("span");
    dot.className = "app-dot";
    dot.dataset.running = String(app.running);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", app.running ? "running" : "not running");

    const name = document.createElement("span");
    name.className = "app-name text-sm";
    name.textContent = app.name;

    const open = document.createElement("button");
    open.type = "button"; open.className = "btn btn-sm"; open.dataset.act = "open";
    open.textContent = app.running ? "Show" : "Open";

    const close = document.createElement("button");
    close.type = "button"; close.className = "btn btn-ghost btn-sm"; close.dataset.act = "close";
    close.textContent = "Close";
    close.disabled = app.protected || !app.running;
    if (app.protected) close.title = "Protected: can't be closed from here";

    row.append(dot, name, open, close);
    return row;
  }));
}

async function loadApps(): Promise<void> {
  const prefs = await loadAppControl();
  if (!prefs.enabled || prefs.allowed.length === 0) { allowedApps = []; renderApps(); return; }
  const res = await send({ type: "apps:list" });
  if (!res?.ok) {
    // Helper missing or unreachable: say so once, in words, rather than showing dead buttons.
    allowedApps = [];
    renderApps();
    return;
  }
  const allowed = new Set(prefs.allowed);
  allowedApps = (res.apps as AppInfo[]).filter((a) => allowed.has(a.id));
  renderApps();
}

async function runApp(verb: Verb, app: AppInfo): Promise<void> {
  appsNote(verb === "open" ? `Opening ${app.name}…` : `Asking ${app.name} to close…`);
  const res = await send({ type: "apps:run", verb, id: app.id, confirmed: verb === "close" });
  if (!res?.ok) { appsNote(describeError(res?.error, app.name)); return; }
  if (verb === "open") appsNote(`Opened ${app.name}.`);
  else if (res.already_closed) appsNote(`${app.name} wasn't running.`);
  else appsNote(res.closed ? `Closed ${app.name}.` : `Asked ${app.name} to close. It may be waiting for you to save something.`);
  window.setTimeout(loadApps, 800); // let the running dots catch up
}

/** Closing can lose unsaved work, so it always asks first, right where the button was. */
function askToClose(app: AppInfo): void {
  const row = el("appsRows").querySelector<HTMLElement>(`.app-row[data-id="${CSS.escape(app.id)}"]`);
  if (!row || row.querySelector(".app-confirm")) return;
  const box = document.createElement("div");
  box.className = "app-confirm text-xs";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-label", `Close ${app.name}?`);
  const msg = document.createElement("span");
  msg.textContent = `Close ${app.name}? Unsaved work in it may be lost.`;
  const yes = document.createElement("button");
  yes.type = "button"; yes.className = "btn btn-primary btn-sm"; yes.textContent = "Close it";
  const no = document.createElement("button");
  no.type = "button"; no.className = "btn btn-ghost btn-sm"; no.textContent = "Cancel";
  yes.addEventListener("click", () => { yes.disabled = no.disabled = true; box.remove(); void runApp("close", app); });
  no.addEventListener("click", () => box.remove());
  box.append(msg, yes, no);
  row.append(box);
  no.focus();
}

function wireApps(): void {
  el<HTMLDivElement>("appsRows").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
    const id = btn?.closest<HTMLElement>(".app-row")?.dataset.id;
    const app = allowedApps.find((a) => a.id === id);
    if (!btn || !app) return;
    if (btn.dataset.act === "open") void runApp("open", app);
    else askToClose(app);
  });

  el<HTMLFormElement>("appsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = el<HTMLInputElement>("appsInput");
    const result = parseAppCommand(input.value, allowedApps);
    if (result.kind === "match") {
      input.value = "";
      if (result.verb === "open") void runApp("open", result.app);
      else if (result.app.protected) appsNote(describeError("protected", result.app.name));
      else { appsNote(""); askToClose(result.app); }
    } else if (result.kind === "ambiguous") {
      appsNote(`Which one: ${result.candidates.map((c) => c.name).join(", ")}?`);
    } else if (result.reason === "no_verb") {
      appsNote('Try "open Zoom" or "close Slack".');
    } else if (result.reason === "empty") {
      appsNote("");
    } else {
      appsNote("I can only use apps you've allowed in Settings.");
    }
  });
}

/* ---------------- controls ---------------- */

function wireControls(): void {
  el<HTMLButtonElement>("automationToggle").addEventListener("click", async () => {
    const toggle = el<HTMLButtonElement>("automationToggle");
    const next = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(next));
    const res = await send({ type: "automation:set", enabled: next });
    renderAutomation(next, res?.synced !== false);
  });

  const snoozeBtn = el<HTMLButtonElement>("snoozeBtn");
  const popover = el<HTMLDivElement>("snoozePopover");
  const openPopover = () => { popover.hidden = false; snoozeBtn.setAttribute("aria-expanded", "true"); };
  const closePopover = () => { popover.hidden = true; snoozeBtn.setAttribute("aria-expanded", "false"); };

  snoozeBtn.addEventListener("click", () => (popover.hidden ? openPopover() : closePopover()));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.hidden) { closePopover(); snoozeBtn.focus(); }
  });
  document.addEventListener("click", (e) => {
    if (!popover.hidden && e.target !== snoozeBtn && !popover.contains(e.target as Node)) closePopover();
  });
  popover.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-mute]") as HTMLButtonElement | null;
    if (!btn) return;
    const v = btn.dataset.mute!;
    const payload = v === "clear" ? { clear: true } : v === "tomorrow" ? { untilTomorrow: true } : { minutes: Number(v) };
    const res = await send({ type: "mute:set", ...payload });
    closePopover();
    renderMute(res?.mutedUntil ? new Date(res.mutedUntil) : null);
  });

  el<HTMLDivElement>("heldList").addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-dismiss]") as HTMLButtonElement | null;
    if (!btn) return;
    btn.closest(".held-item")?.remove();
    await send({ type: "alerts:dismiss", id: btn.dataset.dismiss });
  });
  el<HTMLButtonElement>("flushBtn").addEventListener("click", () => send({ type: "alerts:flush" }));
}

function listenLive(): void {
  if (!ext) return;
  ext.onMessage.addListener((msg: any) => {
    if (msg.type === "quiet:update") renderVerdict(msg.verdict);
    else if (msg.type === "alerts:held") renderHeld(msg.alerts);
    else if (msg.type === "proposals:new") {
      // A notice means nothing was captured and there is something the user should read: a
      // crisis response or a refusal. It stays up long enough to actually be read.
      if (msg.notice) showToast(String(msg.notice), 30_000);
      else {
        const n = msg.proposals?.length ?? 0;
        showToast(n ? `${n} suggested event${n === 1 ? "" : "s"} ready to review` : "No event found in that");
      }
      void loadSuggestions();
    }
    else if (msg.type === "proposals:error") showToast(String(msg.error ?? "Couldn't capture that."), 10_000);
    else if (msg.type === "sync:reconnect") showToast("Your calendar sign-in expired. Reconnect it in Settings.", 10_000);
  });
}

/* ---------------- demo fixture (standalone preview, no extension context) ---------------- */

function isoOffset(mins: number): string {
  return new Date(Date.now() + mins * 60_000).toISOString();
}

function demoData() {
  return {
    verdict: { level: "silent" as QuietLevel, reason: "Quiet until 2:50 — you're in class" },
    events: [
      { title: "Systems lecture", category: "class", start: isoOffset(-57), end: isoOffset(48), location: "Hall B" },
      { title: "Design review", category: "meeting", start: isoOffset(48), end: isoOffset(108), location: "Zoom · with Priya, Marcus" },
      { title: "Lab report 4 due", category: "assignment", start: isoOffset(540), end: isoOffset(540), location: "Canvas · CHEM 210" },
    ] as PanelEvent[],
    heldAlerts: [
      { id: "1", text: "Lab report 4 is due tonight", scheduledFor: isoOffset(-7) },
      { id: "2", text: "Priya moved the design review 30 minutes later", scheduledFor: isoOffset(-14) },
    ] as PanelAlert[],
    automationEnabled: false,
    mutedUntil: null as Date | null,
  };
}

/* ---------------- init ---------------- */

async function init(): Promise<void> {
  await initAppearance();
  wireControls();
  wireSuggestions();
  wireApps();

  if (DEMO) {
    const d = demoData();
    renderVerdict(d.verdict);
    renderDayHeader(d.events);
    renderTimeline(d.events);
    renderPrep(true);
    renderHeld(d.heldAlerts);
    renderAutomation(d.automationEnabled);
    renderMute(d.mutedUntil);
    return;
  }

  listenLive();
  const res = await send({ type: "panel:hello" });
  if (!res?.ok) return;
  renderVerdict(res.verdict);
  renderDayHeader(res.events);
  renderTimeline(res.events);
  renderPrep(res.events.length > 0);
  renderHeld(res.heldAlerts);
  renderAutomation(res.automationEnabled);
  renderMute(res.mutedUntil ? new Date(res.mutedUntil) : null);
  await loadSuggestions();
  await loadApps();
}

init();
