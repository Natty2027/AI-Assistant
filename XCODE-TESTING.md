# Testing in Xcode

Yes — with the caveat that Xcode is for the Safari half only. Keep writing code in VS Code or
Cursor; open Xcode to build, run, and sign.

## What you need

- macOS 13 or later, Xcode 15+
- Node 20+
- A free Apple ID is enough for the Mac and the iOS Simulator. The $99/yr Developer Program
  is only needed for a device build or App Store submission.

## First run (macOS Safari) — about ten minutes

```bash
npm install
npm run check          # 45 tests + typecheck, before you touch Xcode
npm run build:safari   # emits dist/safari
xcrun safari-web-extension-converter dist/safari \
  --project-location ./xcode \
  --app-name "Ambient Cyber Companion" \
  --bundle-identifier com.yourorg.acc \
  --macos-only
```

That generates an Xcode project and opens it. Then:

1. **Product → Run** (⌘R). A small container app launches — that's expected. The app exists
   to host the extension; it isn't the product.
2. Safari → **Settings → Advanced → Show features for web developers**.
3. Safari → **Develop → Allow Unsigned Extensions**. This resets every time Safari quits, so
   you will re-tick it often during development.
4. Safari → **Settings → Extensions** → enable Ambient Cyber Companion.
5. Click the toolbar button. The panel opens as a popup.

**Debugging:** Develop → Web Extension Background Content → your extension. That's the
console for `sw.js`. Right-click inside the popup → Inspect Element for the panel itself.

## iOS Simulator

Drop `--macos-only` from the converter command, pick the iOS scheme, and run against a
simulator. Then in the simulator: Settings → Apps → Safari → Extensions → enable it, and
allow permissions for the sites you're testing.

Expect it to be slower to iterate than macOS. Do your logic work on macOS and use iOS to
check layout and the extension lifecycle.

## What actually works in this build

Working, testable today:

- Both panels render — `ui/sidepanel.html` and `ui/connect-disclosure.html`
- The presence indicator, including the reduced-motion fallback (System Settings →
  Accessibility → Display → Reduce Motion)
- The automation toggle, keyboard-reachable, sending its message to the background
- The disclosure gate's disabled-until-acknowledged behaviour
- Context menu registration on selected text and images
- The quiet-mode resolver, if you stub `/events/active`

Not working until you build a backend — `sw.ts` points `API` at `https://api.example.com`:

- OAuth (needs your token-exchange endpoint; PKCE only, no client secret in the extension)
- Calendar sync, capture, vision extraction
- Anything that reads or writes real events

To exercise the UI without a backend, point `API` at a local mock:

```bash
npx json-server --port 4000 mock.json   # then set API = "http://localhost:4000"
```

## Safari-specific things that will bite

**No `sidePanel` API.** `build.mjs --safari` converts the panel to `action.default_popup`
automatically. Don't add `sidePanel` back for Safari; it silently fails to load the manifest.

**`browser`, not `chrome`.** The Safari build prepends an alias. If you add new source that
touches extension APIs, use `chrome.*` and let the banner handle it.

**Native messaging works differently.** `native-host/quiet-probe.py` is a Chrome-style host
and will not run under Safari — Safari routes native messages through the containing app's
`SafariWebExtensionHandler`. The Safari build drops the `nativeMessaging` permission, so
`probeNativeFocus()` returns `null` and the resolver falls back to calendar evidence and
fails quiet. That's the designed behaviour, not a regression. Porting the Focus probe to
`SafariWebExtensionHandler.swift` is a later task.

**No native messaging at all on iOS.** Same fallback, permanently.

**Unsigned-extension permission resets** on every Safari quit. Not a bug in your code.

**Remote fonts draw scrutiny in review.** Both panels load Hanken Grotesk from Google Fonts.
Self-host it in `ext/ui/fonts/` before submitting.

## Which IDE for what

| Work | Tool |
|---|---|
| TypeScript, backend, schema, tests | VS Code / Cursor / WebStorm |
| Chrome extension (`chrome://extensions` → Load unpacked → `dist/chrome`) | No Xcode needed |
| Safari build, run, sign, ship | Xcode |
| Native Focus probe (Swift) | Xcode |

Xcode has no TypeScript language server, so editing `.ts` there gets you no types, no
autocomplete, and no inline errors. Treat it as a build tool.
