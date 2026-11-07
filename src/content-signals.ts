/**
 * Isolated-world relay. The page-world script (content-signals-main.ts) does the observing;
 * this one owns the extension API and forwards what it hears to the service worker.
 *
 * The page can forge the message this listens for, because it shares a world with the sender.
 * That is acceptable by design: the service worker keys signals by the tab they came from, so
 * a page can only ever describe itself, and the only thing a forged "true" does is make the
 * assistant quieter, which is the safe direction. Nothing here can unlock anything.
 *
 * Reports booleans only, never stream contents or page text.
 */

const MARK = "__pcc_signals__";

function report(screenSharing: boolean, micActive: boolean): void {
  chrome.runtime.sendMessage({ type: "page:signals", screenSharing, micActive }).catch(() => {});
}

window.addEventListener("message", (e: MessageEvent) => {
  // Same window only: ignore frames and anything that did not come from this page itself.
  if (e.source !== window) return;
  const d = e.data;
  if (!d || typeof d !== "object" || d[MARK] !== true) return;
  report(d.screenSharing === true, d.micActive === true);
});

// A page that is going away is no longer sharing. Sent best-effort; the service worker also
// clears a tab's signals itself when it navigates or closes, so a dropped message is harmless.
window.addEventListener("pagehide", () => report(false, false));
