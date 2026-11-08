/**
 * Extension background. Bundled to ext/sw.js by build.ts.
 *
 * Deliberately thin: it wires events to the modules that hold the logic and owns no rules of
 * its own. Anything that decides something belongs in src/, where it can be tested without
 * a browser.
 *
 * Safari note: `chrome` is aliased to `browser` by the polyfill in build.mjs. Safari has no
 * sidePanel API, so the panel opens as a popup there (see manifest.safari.json).
 *
 * State survives MV3 suspending this worker: heldAlerts, lastVerdict and eventsCache are
 * persisted to chrome.storage.local on every change and rehydrated on startup, so reopening
 * the panel after an idle period shows the same state it had before the worker was killed.
 */

import { QuietModeEngine, routeAlert, flushQueue, offlineFallbackEvents } from "./ambient/quietMode";
import type { Alert, ActiveEvent, PageSignals, QuietVerdict } from "./ambient/quietMode";
import { badgeFor } from "./ambient/badge";
import { CAPABILITIES, DISCLOSURE_VERSION, type Provider } from "./providers/capabilities";
import { loadAppControl, loadSettings, STORAGE_KEYS } from "./ui/state";
import { callHost } from "./apps/appControl";

let QUEUE: Alert[] = [];
let lastVerdict: QuietVerdict | null = null;
let pageSignals: PageSignals = { screenSharing: false, micActive: false };

/* ---------------- page signals, kept per tab ----------------
 * One global value is wrong twice over: a second tab reporting "not sharing" would overwrite
 * the first tab's "sharing", and a closed tab would leave its state behind. So signals are
 * stored by tab and combined with OR. They live in chrome.storage.session because MV3 suspends
 * this worker after about 30s idle, which would otherwise forget an ongoing screen share and
 * let the assistant speak in the middle of it. */

type TabSignals = Record<string, PageSignals>;
const SIGNALS_KEY = "tabSignals";
let tabSignals: TabSignals = {};

function combine(map: TabSignals): PageSignals {
  const all = Object.values(map);
  return { screenSharing: all.some((s) => s.screenSharing), micActive: all.some((s) => s.micActive) };
}

async function saveTabSignals(): Promise<void> {
  pageSignals = combine(tabSignals);
  await chrome.storage.session?.set?.({ [SIGNALS_KEY]: tabSignals });
}

async function loadTabSignals(): Promise<void> {
  const got = await chrome.storage.session?.get?.(SIGNALS_KEY);
  tabSignals = (got?.[SIGNALS_KEY] as TabSignals | undefined) ?? {};
  pageSignals = combine(tabSignals);
}

async function setTabSignals(tabId: number, s: PageSignals): Promise<void> {
  if (s.screenSharing || s.micActive) tabSignals[String(tabId)] = s;
  else delete tabSignals[String(tabId)];
  await saveTabSignals();
  await refreshVerdict();
}

async function clearTabSignals(tabId: number): Promise<void> {
  if (!(String(tabId) in tabSignals)) return;
  delete tabSignals[String(tabId)];
  await saveTabSignals();
  await refreshVerdict();
}

// A closed tab, or one that starts loading a new page, is no longer sharing anything. This is
// the backstop for a pagehide message that never arrived. Neither event needs the "tabs" permission.
chrome.tabs?.onRemoved?.addListener((tabId: number) => { void clearTabSignals(tabId); });
chrome.tabs?.onUpdated?.addListener((tabId: number, info: { status?: string }) => {
  if (info.status === "loading") void clearTabSignals(tabId);
});
let automationEnabled = false;

/* ---------------- storage (de)serialization — Dates don't survive chrome.storage as-is ---------------- */

type Stored<T, K extends keyof T> = Omit<T, K> & { [P in K]: string };

function toStoredAlert(a: Alert): Stored<Alert, "scheduledFor"> {
  return { ...a, scheduledFor: a.scheduledFor.toISOString() };
}
function fromStoredAlert(a: Stored<Alert, "scheduledFor">): Alert {
  return { ...a, scheduledFor: new Date(a.scheduledFor) };
}
function toStoredEvent(e: ActiveEvent): Stored<ActiveEvent, "start" | "end"> {
  return { ...e, start: e.start.toISOString(), end: e.end.toISOString() };
}
function fromStoredEvent(e: Stored<ActiveEvent, "start" | "end">): ActiveEvent {
  return { ...e, start: new Date(e.start), end: new Date(e.end) };
}
function toStoredVerdict(v: QuietVerdict): Omit<QuietVerdict, "until"> & { until: string | null } {
  return { ...v, until: v.until ? v.until.toISOString() : null };
}
function fromStoredVerdict(v: Omit<QuietVerdict, "until"> & { until: string | null }): QuietVerdict {
  return { ...v, until: v.until ? new Date(v.until) : null };
}

async function persistQueue(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.heldAlerts]: QUEUE.map(toStoredAlert) });
}
async function persistVerdict(v: QuietVerdict): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastVerdict]: toStoredVerdict(v) });
}
async function persistEventsCache(events: ActiveEvent[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.eventsCache]: events.map(toStoredEvent) });
}

async function rehydrate(): Promise<void> {
  const got = await chrome.storage.local.get([
    STORAGE_KEYS.heldAlerts, STORAGE_KEYS.lastVerdict, STORAGE_KEYS.automationEnabled,
  ]);
  if (Array.isArray(got[STORAGE_KEYS.heldAlerts])) {
    QUEUE = got[STORAGE_KEYS.heldAlerts].map(fromStoredAlert);
  }
  if (got[STORAGE_KEYS.lastVerdict]) {
    lastVerdict = fromStoredVerdict(got[STORAGE_KEYS.lastVerdict]);
  }
  automationEnabled = Boolean(got[STORAGE_KEYS.automationEnabled]);
}

/* ---------------- data access (server-backed; no tokens in the client) ---------------- */

// Injected at build time by build.ts (esbuild `define`). Defaults to the production origin;
// `API_BASE=http://localhost:4000 npm run build` (or `npm run build:mock`) points it at the
// local mock in scripts/mock-server.mjs.
declare const __API_BASE__: string;
const API = __API_BASE__;

async function api(path: string, init: RequestInit = {}) {
  const { [STORAGE_KEYS.authToken]: token } = await chrome.storage.local.get(STORAGE_KEYS.authToken);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    credentials: "include",
  });
  if (!res.ok) {
    // The server's message is written for people ("That sign-in attempt expired…"), so keep it.
    const body = await res.json().then((j: any) => j, () => undefined);
    // `code` is a stable machine-readable reason ("choose_calendar", "reconnect_needed", ...)
    // that the panel branches on, separate from the human wording.
    const err = new Error(body?.error ? String(body.error) : `${path} -> ${res.status}`) as Error & { code?: string };
    err.code = typeof body?.code === "string" ? body.code : undefined;
    throw err;
  }
  return res.json();
}

async function getActiveEvents(): Promise<ActiveEvent[]> {
  try {
    const rows = await api("/events/active");
    const events: ActiveEvent[] = rows.map((r: any) => ({ ...r, start: new Date(r.start), end: new Date(r.end) }));
    // Cache the real result for the panel's timeline, independent of the resolver's own
    // fail-quiet fallback below — the panel should show "last known schedule", not a
    // synthetic busy block.
    persistEventsCache(events);
    return events;
  } catch {
    // Offline. Returning [] would resolve to "full" and let the assistant speak during a
    // meeting it simply can't see, so report a synthetic busy block instead and let the
    // resolver's fail-quiet default hold. See offlineFallbackEvents for the full rationale.
    return offlineFallbackEvents();
  }
}

async function getManualMute() {
  const { [STORAGE_KEYS.mutedUntil]: mutedUntil } = await chrome.storage.local.get(STORAGE_KEYS.mutedUntil);
  const until = mutedUntil ? new Date(mutedUntil) : null;
  return { muted: Boolean(until && until > new Date()), until };
}

async function getQuietHours() {
  return (await loadSettings()).quietHours;
}

const quiet = new QuietModeEngine(getActiveEvents, getManualMute, async () => pageSignals, getQuietHours);

/* ---------------- mute + badge + verdict refresh ---------------- */

/** "Until tomorrow" means tomorrow morning, not the stroke of midnight a few minutes away. */
function tomorrowMorning(now = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

async function setMute(opts: { minutes?: number; untilTomorrow?: boolean; clear?: boolean } = {}): Promise<Date | null> {
  const until = opts.clear
    ? null
    : opts.untilTomorrow
    ? tomorrowMorning()
    : new Date(Date.now() + (opts.minutes ?? (await loadSettings()).defaultSnoozeMinutes) * 60_000);
  await chrome.storage.local.set({ [STORAGE_KEYS.mutedUntil]: until ? until.toISOString() : null });
  await refreshVerdict();
  return until;
}

async function toggleMute(): Promise<void> {
  const { [STORAGE_KEYS.mutedUntil]: stored } = await chrome.storage.local.get(STORAGE_KEYS.mutedUntil);
  const currentlyMuted = Boolean(stored && new Date(stored) > new Date());
  await setMute(currentlyMuted ? { clear: true } : {});
}

async function applyBadge(): Promise<void> {
  if (!lastVerdict) return;
  const { text, color } = badgeFor(lastVerdict, QUEUE.length);
  chrome.action?.setBadgeText?.({ text })?.catch?.(() => {});
  chrome.action?.setBadgeBackgroundColor?.({ color })?.catch?.(() => {});
}

async function refreshVerdict(): Promise<QuietVerdict> {
  const verdict = await quiet.resolve();
  lastVerdict = verdict;
  await persistVerdict(verdict);
  await applyBadge();
  broadcast({ type: "quiet:update", verdict });
  return verdict;
}

function broadcastHeld(): void {
  broadcast({ type: "alerts:held", alerts: QUEUE });
}

/* ---------------- lifecycle ---------------- */

// Signals first: refreshVerdict() reads them, and a verdict computed before they load would
// briefly say "listening" in the middle of a screen share.
Promise.all([rehydrate(), loadTabSignals()]).then(() => applyBadge());

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  chrome.contextMenus.create({
    id: "capture-selection",
    title: "Add to my calendar",
    contexts: ["selection", "image"],
  });
  chrome.alarms.create("tick", { periodInMinutes: 1 });
});

chrome.action?.onClicked?.addListener((tab: any) => {
  // Safari path: no side panel, so open the popup page in a tab.
  if (!chrome.sidePanel) chrome.tabs.create({ url: chrome.runtime.getURL("ui/sidepanel.html") });
  else chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

chrome.commands?.onCommand?.addListener(async (command: string) => {
  if (command === "toggle-mute") await toggleMute();
});

/* ---------------- calendar sync ----------------
 * The server mirrors the next week of each connected calendar. The alarm fires every minute but
 * a sync does not need to, and this worker is torn down between alarms, so the time of the last
 * sync is kept in storage.session rather than a variable that would reset on every wake. */

const SYNC_EVERY_MS = 10 * 60_000;
const LAST_SYNC_KEY = "lastSyncAt";

async function syncNow(force = false): Promise<void> {
  let last = 0;
  try {
    const { [STORAGE_KEYS.authToken]: token } = await chrome.storage.local.get(STORAGE_KEYS.authToken);
    if (!token) return; // not signed in: nothing to sync
    const got = await chrome.storage.session?.get?.(LAST_SYNC_KEY);
    last = Number(got?.[LAST_SYNC_KEY] ?? 0);
    if (!force && Date.now() - last < SYNC_EVERY_MS) return;
    // Stamped before the request so two near-simultaneous callers do not both sync, and put
    // back if the request fails so the next tick retries instead of waiting ten minutes.
    await chrome.storage.session?.set?.({ [LAST_SYNC_KEY]: Date.now() });
    const out = await api("/sync", { method: "POST", body: "{}" });
    if (Array.isArray(out.reconnect) && out.reconnect.length) {
      broadcast({ type: "sync:reconnect", providers: out.reconnect });
    }
    await refreshVerdict();
  } catch {
    // Offline or the server is down. The cached events, and the resolver's fail-quiet
    // fallback, carry on; the next alarm tries again.
    await chrome.storage.session?.set?.({ [LAST_SYNC_KEY]: last });
  }
}

chrome.alarms.onAlarm.addListener(async (a: any) => {
  if (a.name !== "tick") return;
  void syncNow();
  const previous = lastVerdict;
  const verdict = await refreshVerdict();
  const loosened = previous?.level === "silent" && verdict.level !== "silent" && QUEUE.length > 0;
  if (loosened) {
    flushQueue(QUEUE, sinks);
    await persistQueue();
    broadcastHeld();
    await applyBadge();
  }
});

/* ---------------- messages ---------------- */

/** Only the content script may report page signals. Everything else changes state or spends
 *  the user's data, so it must come from one of this extension's own pages (panel, options,
 *  disclosure). A content script runs inside a web page and carries that page's URL, so a
 *  hostile page that manages to drive it cannot, say, turn automation on or start OAuth. */
const PAGE_MESSAGES = new Set(["page:signals"]);

/** Every assistant route the Create page may call. Anything else is refused before any request. */
const ID = "[A-Za-z0-9-]{1,64}";
const AGENT_ROUTES: Array<[string, RegExp]> = [
  ["GET", /^\/agent\/connections$/],
  ["POST", /^\/agent\/connections\/netlify$/],
  ["DELETE", new RegExp(`^/agent/connections/${ID}$`)],
  ["POST", /^\/agent\/run$/],
  ["GET", /^\/agent\/proposals$/],
  ["POST", new RegExp(`^/agent/proposals/${ID}/(approve|execute|reject)$`)],
  ["GET", /^\/agent\/site$/],
  ["GET", /^\/agent\/site\/file\?path=[^#]{1,300}$/],
];
function fromExtensionPage(sender: any): boolean {
  return typeof sender?.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((msg: any, sender: any, respond: any) => {
  (async () => {
    if (!PAGE_MESSAGES.has(msg?.type) && !fromExtensionPage(sender)) {
      return respond({ ok: false, error: "not allowed" });
    }
    switch (msg.type) {
      case "panel:hello": {
        void syncNow(); // opening the panel is a good moment to be current; throttled
        const verdict = lastVerdict ?? (await refreshVerdict());
        const got = await chrome.storage.local.get([STORAGE_KEYS.eventsCache, STORAGE_KEYS.mutedUntil]);
        const events = Array.isArray(got[STORAGE_KEYS.eventsCache])
          ? got[STORAGE_KEYS.eventsCache].map(fromStoredEvent)
          : [];
        const mutedUntil = got[STORAGE_KEYS.mutedUntil] ? new Date(got[STORAGE_KEYS.mutedUntil]) : null;
        return respond({ ok: true, verdict, heldAlerts: QUEUE, events, automationEnabled, mutedUntil });
      }

      case "automation:set": {
        automationEnabled = Boolean(msg.enabled);
        // Saved locally first: the toggle must survive a reopened panel even when the
        // backend call below fails or there is no backend configured yet.
        await chrome.storage.local.set({ [STORAGE_KEYS.automationEnabled]: automationEnabled });
        try {
          await api("/settings/automation", {
            method: "POST",
            body: JSON.stringify({ enabled: automationEnabled }),
          });
          return respond({ ok: true, synced: true });
        } catch (e) {
          return respond({ ok: true, synced: false, error: String((e as Error)?.message ?? e) });
        }
      }

      case "mute:set": {
        const mutedUntil = await setMute(msg);
        return respond({ ok: true, mutedUntil });
      }

      case "alerts:flush": {
        const summary = flushQueue(QUEUE, sinks);
        await persistQueue();
        broadcastHeld();
        await applyBadge();
        return respond({ ok: true, summary });
      }

      case "alerts:dismiss": {
        QUEUE = QUEUE.filter((a) => a.id !== msg.id);
        await persistQueue();
        broadcastHeld();
        await applyBadge();
        return respond({ ok: true });
      }

      case "page:signals": {
        // Keyed by the sending tab, so a page can only ever describe itself.
        const tabId = sender?.tab?.id;
        if (typeof tabId !== "number") return respond({ ok: false, error: "no tab" });
        await setTabSignals(tabId, { screenSharing: msg.screenSharing === true, micActive: msg.micActive === true });
        return respond({ ok: true });
      }

      case "disclosure:acknowledge":
        if (typeof msg.provider !== "string" || !Object.hasOwn(CAPABILITIES, msg.provider)) return respond({ ok: false, error: "unknown provider" });
        // Recorded before OAuth begins. The database refuses a connection without it, so
        // this is the gate, not a formality.
        await api("/disclosures", {
          method: "POST",
          body: JSON.stringify({ provider: msg.provider, version: DISCLOSURE_VERSION }),
        });
        return respond({ ok: true });

      case "oauth:begin": {
        if (typeof msg.provider !== "string" || !Object.hasOwn(CAPABILITIES, msg.provider)) return respond({ ok: false, error: "unknown provider" });
        const provider = msg.provider as Provider;
        const redirect = chrome.identity.getRedirectURL("oauth");
        const { authUrl } = await api(
          `/oauth/start?provider=${encodeURIComponent(provider)}&redirect=${encodeURIComponent(redirect)}`
        );
        // PKCE only. The token exchange happens on the backend; no client secret and no
        // refresh token ever reaches this context.
        const done = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
        await api("/oauth/complete", { method: "POST", body: JSON.stringify({ provider, done }) });
        return respond({ ok: true, provider, capability: CAPABILITIES[provider] });
      }

      case "apps:list": {
        // Reaches the helper only when the user turned app control on.
        if (!(await loadAppControl()).enabled) return respond({ ok: false, error: "disabled" });
        return respond(await callHost({ op: "list" }));
      }

      case "apps:run": {
        const prefs = await loadAppControl();
        if (!prefs.enabled) return respond({ ok: false, error: "disabled" });
        if (msg.verb !== "open" && msg.verb !== "close") return respond({ ok: false, error: "bad_request" });
        if (typeof msg.id !== "string" || !prefs.allowed.includes(msg.id)) return respond({ ok: false, error: "not_allowed" });
        // Closing can lose unsaved work, so the panel must have shown the user a confirmation.
        if (msg.verb === "close" && msg.confirmed !== true) return respond({ ok: false, error: "confirmation_required" });
        return respond(await callHost({ op: msg.verb === "open" ? "open" : "quit", id: msg.id }));
      }

      case "proposals:list": {
        const out = await api("/proposals");
        return respond({ ok: true, proposals: out.proposals ?? [] });
      }

      case "proposal:confirm": {
        if (typeof msg.id !== "string") return respond({ ok: false, error: "missing id" });
        // Only what the user typed is sent; the server re-validates every field.
        const out = await api(`/proposals/${encodeURIComponent(msg.id)}/confirm`, {
          method: "POST",
          body: JSON.stringify({ start: msg.start, end: msg.end, provider: msg.provider }),
        });
        void syncNow(true); // the new event should show up in the timeline and the resolver
        return respond({ ok: true, provider: out.provider });
      }

      case "proposal:reject": {
        if (typeof msg.id !== "string") return respond({ ok: false, error: "missing id" });
        await api(`/proposals/${encodeURIComponent(msg.id)}/reject`, { method: "POST", body: "{}" });
        return respond({ ok: true });
      }

      case "consent:get": {
        try {
          const c = await api("/consent/ai");
          return respond({ ok: true, granted: Boolean(c.granted) });
        } catch (e) {
          return respond({ ok: false, error: String((e as Error)?.message ?? e) });
        }
      }

      case "consent:set": {
        const c = await api("/consent/ai", {
          method: "POST",
          body: JSON.stringify({ granted: msg.granted === true }),
        });
        return respond({ ok: true, granted: Boolean(c.granted) });
      }

      case "account:delete": {
        // Server first: if it fails we keep the local state so the user can retry.
        await api("/account/delete", { method: "POST", body: JSON.stringify({ confirm: msg.confirm }) });
        QUEUE = [];
        lastVerdict = null;
        automationEnabled = false;
        await chrome.storage.local.clear();
        return respond({ ok: true });
      }

      case "agent:call": {
        // The Create page reaches the assistant's routes through here, so the sign-in token
        // never enters a page. Only the routes in AGENT_ROUTES can be reached.
        const method = String(msg.method ?? "GET").toUpperCase();
        const path = String(msg.path ?? "");
        if (!AGENT_ROUTES.some(([m, re]) => m === method && re.test(path))) return respond({ ok: false, error: "not allowed" });
        const out = await api(path, method === "GET" ? { method } : { method, body: JSON.stringify(msg.body ?? {}) });
        return respond({ ok: true, data: out });
      }

      case "disclosure:cancel":
        return respond({ ok: true });

      default:
        return respond({ ok: false, error: "unknown message" });
    }
  })().catch((e) => respond({ ok: false, error: String(e?.message ?? e), code: e?.code }));

  return true; // async response
});

/* ---------------- capture ---------------- */

chrome.contextMenus.onClicked.addListener(async (info: any) => {
  if (info.menuItemId !== "capture-selection") return;
  // The timezone lets the server resolve "Friday at 7pm" to the right instant.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const payload = info.srcUrl
    ? { kind: "image", url: info.srcUrl, timezone }
    : { kind: "text", text: info.selectionText, timezone };
  try {
    const { proposals, notice } = await api("/capture", { method: "POST", body: JSON.stringify(payload) });
    broadcast({ type: "proposals:new", proposals, notice });
  } catch (e) {
    broadcast({ type: "proposals:error", error: String((e as Error)?.message ?? e) });
  }
});

/* ---------------- alert sinks ---------------- */

const sinks = {
  playChime: (a: Alert) => broadcast({ type: "alert:chime", alert: a }),
  speak: (a: Alert) => broadcast({ type: "alert:speak", alert: a }),
  showOverlay: (a: Alert) => broadcast({ type: "alert:overlay", alert: a }),
  updatePanel: (a: Alert) => broadcast({ type: "alert:panel", alert: a }),
  enqueue: (a: Alert, reason: string) => {
    QUEUE.push(a);
    persistQueue();
    broadcast({ type: "alert:queued", alert: a, reason });
    broadcastHeld();
    applyBadge();
  },
};

export async function deliver(alert: Alert) {
  routeAlert(alert, lastVerdict ?? (await quiet.resolve()), sinks);
}

function broadcast(msg: unknown) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // no panel open; fine
}
