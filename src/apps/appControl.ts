/**
 * The extension's side of the app-control helper (native-host/app-control.py).
 *
 * The browser may only talk to a native program that the user installed AND that names this
 * extension in its manifest, so a web page cannot reach it. This module adds the second half:
 * nothing is sent unless the user turned app control on and ticked that specific app.
 */

export const APP_HOST = "com.acc.appcontrol";

export type AppError =
  | "host_missing" | "unsupported_platform" | "permission_needed" | "protected" | "unknown_app"
  | "bad_id" | "bad_request" | "unknown_op" | "rate_limited" | "timed_out" | "failed"
  | "disabled" | "not_allowed" | "confirmation_required";

export interface HostReply {
  ok: boolean;
  error?: AppError;
  name?: string;
  closed?: boolean;
  already_closed?: boolean;
  apps?: Array<{ id: string; name: string; running: boolean; protected: boolean }>;
}

/** Sends one request to the helper. A missing helper is reported as an answer, not thrown. */
export function callHost(message: Record<string, unknown>): Promise<HostReply> {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendNativeMessage) {
      return resolve({ ok: false, error: "host_missing" });
    }
    chrome.runtime.sendNativeMessage(APP_HOST, message, (reply: HostReply | undefined) => {
      // lastError is set when the helper is not installed, does not list this extension, or crashed.
      if (chrome.runtime.lastError || !reply) return resolve({ ok: false, error: "host_missing" });
      resolve(reply);
    });
  });
}

/** Words for a person, never a raw code. `name` is the app, when there is one. */
export function describeError(code: AppError | string | undefined, name?: string): string {
  const app = name || "that app";
  switch (code) {
    case "host_missing": return "The app helper isn't installed yet. Settings explains how to set it up.";
    case "unsupported_platform": return "Opening and closing apps only works on macOS for now.";
    case "permission_needed": return `macOS needs your OK before it will let me close ${app}. Look for a permission prompt, allow it, then try again.`;
    case "protected": return `${app} is protected, so it can't be closed from here. (Closing it could end this extension or lose your open pages.)`;
    case "unknown_app": return `${app} doesn't seem to be installed any more.`;
    case "rate_limited": return "That's a lot of requests at once. Wait a moment and try again.";
    case "timed_out": return `${app} took too long to respond.`;
    case "disabled": return "App control is off. Turn it on in Settings.";
    case "not_allowed": return `${app} isn't one of the apps you've allowed. Tick it in Settings first.`;
    case "confirmation_required": return "Closing an app needs your confirmation first.";
    case "bad_id": case "bad_request": case "unknown_op": case "failed":
    default: return `Couldn't do that with ${app}.`;
  }
}
