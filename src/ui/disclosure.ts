/**
 * Connect-disclosure page logic. Previously inline in connect-disclosure.html and always
 * showing the Canvas-iCal copy verbatim, regardless of `?provider=` — MV3's CSP blocks
 * inline scripts, so the file never ran in the real extension, and the hardcoded copy was
 * never exercised against a real provider either. Renders from CAPABILITIES now, so Google
 * and Microsoft actually show their own (very different — full read/write) disclosure.
 */

import { initAppearance } from "./appearance";
import { CAPABILITIES, UNIVERSAL_DISCLOSURE, type Provider } from "../providers/capabilities";

const ext = typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime : null;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function provider(): Provider {
  const p = new URLSearchParams(location.search).get("provider");
  return (p && p in CAPABILITIES ? p : "canvas_ical") as Provider;
}

function render(p: Provider): void {
  const cap = CAPABILITIES[p];

  el("monogram").textContent = cap.label.charAt(0).toUpperCase();
  el("heading").textContent = `Before connecting ${cap.label}`;

  const facts: Array<{ ok: boolean; text: string }> = [
    { ok: true, text: `I'll read your ${cap.label.toLowerCase()}.` },
    { ok: cap.write !== "none", text: cap.disclosure },
    { ok: false, text: UNIVERSAL_DISCLOSURE[1] },
    { ok: true, text: UNIVERSAL_DISCLOSURE[0] },
  ];
  el("factList").innerHTML = facts.map((f) => `
    <div class="fact">
      <span class="mark ${f.ok ? "yes" : "no"}" aria-hidden="true">${f.ok ? "✓" : "✕"}</span>
      <p class="text-sm">${f.text}</p>
    </div>
  `).join("");

  el("ackText").textContent = cap.write === "none"
    ? "I understand this calendar is read-only, and that I'm responsible for verifying dates and deadlines that matter."
    : "I understand this assistant can misread dates, and that I'm responsible for confirming anything it creates, moves, or deletes.";

  el<HTMLButtonElement>("continue").textContent = `Continue to ${cap.label}`;
}

function wire(p: Provider): void {
  const ack = el<HTMLInputElement>("ack");
  const go = el<HTMLButtonElement>("continue");

  ack.addEventListener("change", () => { go.disabled = !ack.checked; });

  go.addEventListener("click", () => {
    if (!ack.checked || !ext) return;
    // The acknowledgement is recorded server-side BEFORE the OAuth window opens. The
    // database rejects a connection row that has no matching acknowledgement, so a bug in
    // this page cannot skip the disclosure.
    ext.sendMessage({ type: "disclosure:acknowledge", provider: p }, () => {
      ext.sendMessage({ type: "oauth:begin", provider: p });
    });
  });

  el<HTMLButtonElement>("cancel").addEventListener("click", () => {
    if (ext) ext.sendMessage({ type: "disclosure:cancel", provider: p });
    else window.close();
  });
}

async function init(): Promise<void> {
  await initAppearance();
  const p = provider();
  render(p);
  wire(p);
}

init();
