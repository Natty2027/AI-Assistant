# Testing the extension locally (Chrome + mock backend)

The panels have no real backend by default — `src/sw.ts` points `API` at `https://api.example.com`.
This sets up a local mock so the **service worker** actually functions. Node 20+ required
(`export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"` on this machine).

## 1. Start the mock backend

```bash
npm run mock            # http://localhost:4000, logs each request
```

It serves exactly the endpoints the service worker calls: `/events/active`,
`/settings/automation`, `/disclosures`, `/oauth/start`, `/oauth/complete`, `/capture`.
`/events/active` returns one currently-active class, so the resolver stays quiet.

## 2. Build a dev bundle pointed at the mock

In a second terminal:

```bash
npm run build:mock      # builds dist/chrome with API = http://localhost:4000
```

This build (and only this build) also adds `http://localhost:4000/*` to `host_permissions`
so MV3 lets the service worker fetch the mock. The normal `npm run build` is unchanged.

## 3. Load it in Chrome

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/chrome`.
2. Click **service worker** on the extension card to open its DevTools console.
3. Click the toolbar icon to open the side panel.

## What you can actually observe

- **Service-worker console (the real payoff):** every `/events/active` poll, the
  `automation:set` POST when you flip the toggle, and `/capture` when you use the right-click
  **"Add to my calendar"** menu on selected text or an image. Watch the mock terminal for the
  matching request logs.
- **Automation toggle:** flipping it in the panel POSTs to `/settings/automation` (visible in
  both consoles).
- **Offline fail-quiet fix:** stop the mock (`Ctrl-C`) and wait for the next tick (~1 min).
  The resolver keeps the last quiet verdict instead of going loud — that's the `sw.ts`
  `getActiveEvents` fallback. (`npm test` covers this deterministically.)
- **Disclosure / OAuth handshake:** open the standalone page by URL —
  `chrome-extension://<extension-id>/ui/connect-disclosure.html?provider=google` — tick the
  box, click **Continue**. It fires `disclosure:acknowledge` then `oauth:begin`, which the
  service worker turns into a `/oauth/start` call (visible in the mock log).

## What you will NOT see (by design, today)

The side panel is a **static mockup**: its schedule, prep card, and held-alerts are hardcoded
HTML, and it has no listener for the service worker's `quiet:update` / `proposals:new`
broadcasts. So the mock drives the service worker, not the panel visuals. Making the panel
reflect live quiet-state / proposals is a small, separate change (add a `chrome.runtime
.onMessage` listener to `ui/sidepanel.html`) — ask if you want it.

## Cleanup

Stop the mock with `Ctrl-C`. Re-run `npm run build` for a normal (production-origin) bundle.
