/**
 * Shared storage schema. One place for settings persistence and the raw `chrome.storage.local`
 * key names, since the service worker and three UI pages all touch a subset of them.
 *
 * Everything the service worker persists beyond settings — heldAlerts, lastVerdict,
 * eventsCache, mutedUntil, automationEnabled — is read and written only by sw.ts. UI pages
 * never read those keys directly; they ask for a snapshot over a runtime message instead, so
 * the serialization format (Date <-> ISO string) has exactly one owner.
 */

export type Theme = "auto" | "light" | "dark";
export type GradientPreset = "dusk" | "ember" | "glacier" | "grove";

export interface QuietHoursPrefs {
  enabled: boolean;
  /** 24h local time, "HH:MM". */
  start: string;
  end: string;
}

export interface Settings {
  theme: Theme;
  gradient: GradientPreset;
  defaultSnoozeMinutes: number;
  quietHours: QuietHoursPrefs;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "auto",
  gradient: "dusk",
  defaultSnoozeMinutes: 60,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};

export const STORAGE_KEYS = {
  settings: "settings",
  mutedUntil: "mutedUntil",
  automationEnabled: "automationEnabled",
  heldAlerts: "heldAlerts",
  lastVerdict: "lastVerdict",
  eventsCache: "eventsCache",
  /** Bearer token sent to the backend. Staging stand-in for sign-in; see server/auth.ts. */
  authToken: "authToken",
  /** Which desktop apps the assistant may open and close. Off, and empty, by default. */
  appControl: "appControl",
} as const;

export interface AppControlPrefs {
  enabled: boolean;
  /** Bundle identifiers the user has ticked. Anything not listed is refused. */
  allowed: string[];
}

export const DEFAULT_APP_CONTROL: AppControlPrefs = { enabled: false, allowed: [] };

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,127}$/;

/** Whatever is in storage, coerced to something safe. A corrupted or hand-edited value can
 *  only ever shrink what is allowed, never widen it. */
export function sanitizeAppControl(raw: unknown): AppControlPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AppControlPrefs>;
  const allowed = Array.isArray(r.allowed)
    ? [...new Set(r.allowed.filter((x): x is string => typeof x === "string" && BUNDLE_ID.test(x)))].slice(0, 200)
    : [];
  return { enabled: r.enabled === true, allowed };
}

export async function loadAppControl(): Promise<AppControlPrefs> {
  const area = storageArea();
  if (!area) return DEFAULT_APP_CONTROL;
  const got = await area.get(STORAGE_KEYS.appControl);
  return sanitizeAppControl(got[STORAGE_KEYS.appControl]);
}

export async function saveAppControl(patch: Partial<AppControlPrefs>): Promise<AppControlPrefs> {
  const next = sanitizeAppControl({ ...(await loadAppControl()), ...patch });
  const area = storageArea();
  if (area) await area.set({ [STORAGE_KEYS.appControl]: next });
  return next;
}

function storageArea(): any {
  return typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null;
}

function mergeSettings(partial: Partial<Settings> | undefined | null): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    quietHours: { ...DEFAULT_SETTINGS.quietHours, ...(partial?.quietHours ?? {}) },
  };
}

export async function loadSettings(): Promise<Settings> {
  const area = storageArea();
  if (!area) return DEFAULT_SETTINGS;
  const got = await area.get(STORAGE_KEYS.settings);
  return mergeSettings(got[STORAGE_KEYS.settings] as Partial<Settings> | undefined);
}

/** Shallow-patches settings; `quietHours` patches merge one level deep rather than replacing. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    quietHours: { ...current.quietHours, ...(patch.quietHours ?? {}) },
  });
  const area = storageArea();
  if (area) await area.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

/** Fires on any settings change from another context (e.g. the options page, while the panel is open). */
export function onSettingsChanged(cb: (s: Settings) => void): void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "local" || !changes[STORAGE_KEYS.settings]) return;
    cb(mergeSettings(changes[STORAGE_KEYS.settings].newValue as Partial<Settings> | undefined));
  });
}
