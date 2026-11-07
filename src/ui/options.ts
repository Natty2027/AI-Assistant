/**
 * Options page: appearance, quiet hours, keyboard shortcuts, the "what's being observed"
 * transparency view, and calendar connections. New page — there was no options_ui entry
 * before this, so none of this was reachable.
 */

import { initAppearance } from "./appearance";
import { loadAppControl, loadSettings, saveAppControl, saveSettings, STORAGE_KEYS, type GradientPreset, type Theme, type Settings } from "./state";
import { describeError } from "../apps/appControl";
import { CAPABILITIES, type Provider } from "../providers/capabilities";
import { probeNativeFocus } from "../ambient/quietMode";

const ext = typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime : null;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ---------------- appearance ---------------- */

const GRADIENTS: GradientPreset[] = ["dusk", "ember", "glacier", "grove"];
const GRADIENT_LABEL: Record<GradientPreset, string> = { dusk: "Dusk", ember: "Ember", glacier: "Glacier", grove: "Grove" };
const GRADIENT_COLORS: Record<GradientPreset, [string, string]> = {
  dusk: ["#7FA8A0", "#4C7F9E"],
  ember: ["#C8A98A", "#D97757"],
  glacier: ["#8FD3E8", "#5AA9D6"],
  grove: ["#9BCB8C", "#4F9A6E"],
};

function renderAppearance(settings: Settings): void {
  el<HTMLSelectElement>("themeSelect").value = settings.theme;
  el<HTMLDivElement>("gradientRow").innerHTML = GRADIENTS.map((g) => {
    const [c1, c2] = GRADIENT_COLORS[g];
    return `<button type="button" class="swatch" data-gradient="${g}" aria-pressed="${g === settings.gradient}"
      aria-label="${GRADIENT_LABEL[g]}" title="${GRADIENT_LABEL[g]}"
      style="background:linear-gradient(135deg, ${c1}, ${c2})"></button>`;
  }).join("");
}

function wireAppearance(): void {
  el<HTMLSelectElement>("themeSelect").addEventListener("change", (e) => {
    saveSettings({ theme: (e.target as HTMLSelectElement).value as Theme });
  });
  el<HTMLDivElement>("gradientRow").addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-gradient]") as HTMLButtonElement | null;
    if (!btn) return;
    const gradient = btn.dataset.gradient as GradientPreset;
    await saveSettings({ gradient });
    renderAppearance(await loadSettings());
  });
}

/* ---------------- quiet (snooze default + quiet hours) ---------------- */

function renderQuiet(settings: Settings): void {
  el<HTMLSelectElement>("snoozeMinutes").value = String(settings.defaultSnoozeMinutes);
  el<HTMLButtonElement>("quietHoursToggle").setAttribute("aria-checked", String(settings.quietHours.enabled));
  el<HTMLInputElement>("quietHoursStart").value = settings.quietHours.start;
  el<HTMLInputElement>("quietHoursEnd").value = settings.quietHours.end;
  el<HTMLDivElement>("quietHoursTimes").hidden = !settings.quietHours.enabled;
}

function currentQuietHours() {
  return {
    enabled: el<HTMLButtonElement>("quietHoursToggle").getAttribute("aria-checked") === "true",
    start: el<HTMLInputElement>("quietHoursStart").value,
    end: el<HTMLInputElement>("quietHoursEnd").value,
  };
}

function wireQuiet(): void {
  el<HTMLSelectElement>("snoozeMinutes").addEventListener("change", (e) => {
    saveSettings({ defaultSnoozeMinutes: Number((e.target as HTMLSelectElement).value) });
  });

  const toggle = el<HTMLButtonElement>("quietHoursToggle");
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(next));
    el<HTMLDivElement>("quietHoursTimes").hidden = !next;
    saveSettings({ quietHours: { ...currentQuietHours(), enabled: next } });
  });

  for (const id of ["quietHoursStart", "quietHoursEnd"]) {
    el<HTMLInputElement>(id).addEventListener("change", () => {
      saveSettings({ quietHours: currentQuietHours() });
    });
  }
}

/* ---------------- shortcuts ---------------- */

async function renderShortcuts(): Promise<void> {
  const box = el<HTMLDivElement>("shortcutsList");
  if (!ext || typeof chrome.commands?.getAll !== "function") {
    box.innerHTML = `<p class="text-sm text-muted">Shortcuts are only available inside the installed extension.</p>`;
    return;
  }
  const commands: Array<{ name: string; description?: string; shortcut?: string }> =
    await new Promise((resolve) => chrome.commands.getAll(resolve));
  box.innerHTML = commands.length
    ? commands.map((c) => `
        <div class="opt-row">
          <label>${escapeHtml(c.description || c.name)}</label>
          <span class="text-sm text-muted">${c.shortcut ? escapeHtml(c.shortcut) : "Not set"}</span>
        </div>
      `).join("")
    : `<p class="text-sm text-muted">No shortcuts declared.</p>`;
}

function wireShortcuts(): void {
  el<HTMLButtonElement>("openShortcutsBtn").addEventListener("click", () => {
    chrome.tabs?.create?.({ url: "chrome://extensions/shortcuts" });
  });
}

/* ---------------- privacy: what's being observed ---------------- */

async function renderPrivacy(): Promise<void> {
  const kv = el<HTMLDListElement>("observedKv");
  if (!ext) {
    kv.innerHTML = `<dt>Context</dt><dd>Not running inside the extension</dd>`;
    return;
  }
  const all: Record<string, unknown> = await chrome.storage.local.get(null);
  const keys = Object.keys(all);
  const nativeFocus = await probeNativeFocus();

  const rows: Array<[string, string]> = [
    ["Stored locally", keys.length ? keys.join(", ") : "(nothing yet)"],
    ["Screen-share / mic signals", "read while a tab or the panel is open to resolve quiet mode — never streamed, never logged"],
    [
      "Native Focus host",
      nativeFocus === null
        ? "not installed — falls back to calendar evidence"
        : nativeFocus.active
        ? `connected — Focus is on (${nativeFocus.label ?? "unnamed"})`
        : "connected — Focus is currently off",
    ],
    ["Calendar / account access", "none yet — no backend is configured for this build"],
  ];
  kv.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
}

function wirePrivacy(): void {
  el<HTMLButtonElement>("clearDataBtn").addEventListener("click", async () => {
    if (!ext) return;
    await chrome.storage.local.clear();
    location.reload();
  });
}

/* ---------------- connections ---------------- */

function renderConnections(): void {
  const writeLabel = { full: "Full read/write", partial: "Read, partial write", none: "Read-only" } as const;
  el<HTMLDivElement>("connectionsList").innerHTML = (Object.keys(CAPABILITIES) as Provider[]).map((p) => {
    const cap = CAPABILITIES[p];
    return `
      <div class="opt-row">
        <div>
          <div class="text-sm font-medium">${escapeHtml(cap.label)}</div>
          <div class="text-xs text-muted">${writeLabel[cap.write]}</div>
        </div>
        <a class="btn btn-sm" href="connect-disclosure.html?provider=${p}">Connect</a>
      </div>
    `;
  }).join("");
}

/* ---------------- account (staging token) ---------------- */

async function wireAccount(): Promise<void> {
  const input = el<HTMLInputElement>("authToken");
  const status = el<HTMLSpanElement>("tokenStatus");
  if (!ext) return;
  const got = await chrome.storage.local.get(STORAGE_KEYS.authToken);
  if (got[STORAGE_KEYS.authToken]) status.textContent = "A token is saved.";

  el<HTMLButtonElement>("saveTokenBtn").addEventListener("click", async () => {
    const value = input.value.trim();
    if (value) await chrome.storage.local.set({ [STORAGE_KEYS.authToken]: value });
    else await chrome.storage.local.remove(STORAGE_KEYS.authToken);
    input.value = "";
    status.textContent = value ? "Saved." : "Token removed.";
  });
}

/* ---------------- AI consent + data deletion ---------------- */

/** Ask the service worker, which owns every call to the server. */
function send<T = any>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (res: T) => resolve(res)));
}

async function wireConsent(): Promise<void> {
  const toggle = el<HTMLButtonElement>("aiConsentToggle");
  const status = el<HTMLParagraphElement>("aiConsentStatus");
  if (!ext) { toggle.disabled = true; return; }

  const show = (granted: boolean, note = "") => {
    toggle.setAttribute("aria-checked", String(granted));
    status.textContent = note || (granted ? "On. Captured text and images are sent to Anthropic." : "Off. Nothing is sent.");
  };

  const current = await send({ type: "consent:get" });
  if (current?.ok) show(Boolean(current.granted));
  else { show(false, "Couldn't reach the server, so this is treated as off."); }

  toggle.addEventListener("click", async () => {
    const next = toggle.getAttribute("aria-checked") !== "true";
    toggle.disabled = true;
    const res = await send({ type: "consent:set", granted: next });
    toggle.disabled = false;
    if (res?.ok) show(Boolean(res.granted));
    else show(!next, `Couldn't save that: ${res?.error ?? "server unreachable"}`);
  });
}

function wireDelete(): void {
  const input = el<HTMLInputElement>("deleteConfirm");
  const btn = el<HTMLButtonElement>("deleteDataBtn");
  const status = el<HTMLSpanElement>("deleteStatus");
  if (!ext) return;

  input.addEventListener("input", () => { btn.disabled = input.value !== "DELETE"; });

  let inFlight = false; // a double click must not fire two deletions
  btn.addEventListener("click", async () => {
    if (inFlight || input.value !== "DELETE") return;
    inFlight = true;
    btn.disabled = true;
    status.textContent = "Deleting…";
    const res = await send({ type: "account:delete", confirm: input.value });
    if (res?.ok) {
      status.textContent = "Everything was deleted.";
      input.value = "";
    } else {
      status.textContent = `Couldn't delete: ${res?.error ?? "server unreachable"}. Nothing was changed.`;
      btn.disabled = input.value !== "DELETE";
    }
    inFlight = false;
  });
}

/* ---------------- opening and closing apps ---------------- */

type HostApp = { id: string; name: string; running: boolean; protected: boolean };

/** Built with DOM calls, not innerHTML: an app's name is whatever its folder is called on disk. */
function appRow(app: HostApp, allowed: boolean, onToggle: (checked: boolean) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "apps-row";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = `app-${app.id}`;
  box.checked = allowed;
  box.addEventListener("change", () => onToggle(box.checked));
  const label = document.createElement("label");
  label.htmlFor = box.id;
  label.textContent = app.name;
  row.append(box, label);
  const tags = [app.running ? "running" : "", app.protected ? "can be opened, never closed" : ""].filter(Boolean).join(" · ");
  if (tags) {
    const t = document.createElement("span");
    t.className = "apps-tag";
    t.textContent = tags;
    row.append(t);
  }
  return row;
}

async function wireApps(): Promise<void> {
  const toggle = el<HTMLButtonElement>("appsToggle");
  const status = el<HTMLParagraphElement>("appsStatus");
  const picker = el<HTMLDivElement>("appsPicker");
  const search = el<HTMLInputElement>("appsSearch");
  const list = el<HTMLDivElement>("appsList");
  if (!ext) { toggle.disabled = true; return; }

  let apps: HostApp[] = [];
  let allowed = new Set<string>();

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = apps.filter((a) => !q || a.name.toLowerCase().includes(q)).slice(0, 150);
    list.replaceChildren(...shown.map((a) => appRow(a, allowed.has(a.id), async (on) => {
      if (on) allowed.add(a.id); else allowed.delete(a.id);
      await saveAppControl({ allowed: [...allowed] });
      status.textContent = `${allowed.size} app${allowed.size === 1 ? "" : "s"} allowed.`;
    })));
    if (!shown.length) list.textContent = "No apps match.";
  };

  async function load(): Promise<void> {
    status.textContent = "Looking for your apps…";
    const res = await send({ type: "apps:list" });
    if (!res?.ok) {
      picker.hidden = true;
      status.textContent = describeError(res?.error);
      return;
    }
    apps = res.apps as HostApp[];
    picker.hidden = false;
    status.textContent = `${allowed.size} app${allowed.size === 1 ? "" : "s"} allowed. Tick the ones you want to be able to open and close.`;
    draw();
  }

  const prefs = await loadAppControl();
  allowed = new Set(prefs.allowed);
  toggle.setAttribute("aria-checked", String(prefs.enabled));
  if (prefs.enabled) await load();

  toggle.addEventListener("click", async () => {
    const next = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(next));
    await saveAppControl({ enabled: next });
    if (next) await load();
    else { picker.hidden = true; status.textContent = "Off. Nothing can open or close apps."; }
  });
  search.addEventListener("input", draw);
}

/* ---------------- init ---------------- */

async function init(): Promise<void> {
  await initAppearance();
  const settings = await loadSettings();
  renderAppearance(settings);
  renderQuiet(settings);
  wireAppearance();
  wireQuiet();
  wireShortcuts();
  wirePrivacy();
  renderConnections();
  wireDelete();
  await Promise.all([renderShortcuts(), renderPrivacy(), wireAccount(), wireConsent(), wireApps()]);
}

init();
