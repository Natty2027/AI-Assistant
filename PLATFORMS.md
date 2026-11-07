# Platforms

## Editors

Any. Plain TypeScript, npm scripts, no editor config committed, no proprietary project file.
VS Code, Cursor, WebStorm, Neovim, Zed, Sublime — all equivalent. `npm run check` is the
whole contract.

The one exception is Apple's, not ours: **shipping to the App Store requires Xcode on
macOS.** No editor substitutes for the signing step. If nobody on the team has a Mac, a
GitHub Actions `macos-latest` runner does it in CI — `xcrun safari-web-extension-converter`
and `xcodebuild` both run headless there.

## Browsers

One source tree, four outputs. `npm run build` emits all of them.

| Browser | Build | Panel surface | Notes |
|---|---|---|---|
| Chrome | `dist/chrome` | Side panel | Reference target |
| Edge | `dist/edge` | Side panel | Same bundle; separate store listing |
| Brave, Opera, Arc, Vivaldi | `dist/chrome` | Side panel | Chromium — load the Chrome build |
| Firefox | `dist/firefox` | Sidebar | Event page, not service worker; needs a gecko id |
| Safari macOS | `dist/safari` | Popup | Via Xcode converter |
| Safari iOS | `dist/safari` | Popup | Same, plus the limits below |

Load unpacked: Chrome/Edge `chrome://extensions`; Firefox `about:debugging` → This Firefox →
Load Temporary Add-on → pick `dist/firefox/manifest.json`; Safari see XCODE-TESTING.md.

The differences that would otherwise cost you a day each are in `src/platform/manifest.ts`
and covered by 11 tests. Firefox silently installs and does nothing if you ship
`service_worker`; it refuses to install at all without a gecko id; Safari rejects
`side_panel`.

## Operating systems

The extension runs wherever its browser runs. What varies is the OS Focus probe.

| OS | Focus/DND detection | How |
|---|---|---|
| macOS 12+ | Yes | Native host reads the Focus assertions store |
| Windows 10/11 | Yes | Native host calls `SHQueryUserNotificationState` |
| Linux (GNOME/KDE) | Yes | Native host reads gsettings / plasmanotifyrc |
| ChromeOS | No | Falls back to calendar + page heuristics |
| iOS / iPadOS | **No, permanently** | No native messaging exists on iOS |
| Android | No | Firefox for Android supports extensions; no host access |

Every "no" degrades identically: `probeNativeFocus()` returns null, the resolver loses one
evidence source, and the fail-quiet default holds. Nothing errors.

### The Windows bug worth knowing about

The native host now forces binary stdio on Windows. Native messaging frames a 4-byte
little-endian length ahead of the payload; Windows text mode rewrites `\n` as `\r\n`, so any
frame whose header or body contained a `0x0A` byte was corrupted. It presented as the host
failing intermittently on Windows only, depending on payload length. `msvcrt.setmode` before
any byte moves.

Also on Windows: browsers cannot execute `.py` directly. Point the host manifest at a `.bat`
launcher — see `native-host/INSTALL.md`.

## iOS: the real constraint

Extensions run, and the panel and capture flows work. Two things do not, and no amount of
code fixes them:

**Background execution.** iOS gives Safari extensions no reliable background lifecycle.
`chrome.alarms` will not wake your extension to deliver a 2:00 PM reminder. Scheduled
reminders on iOS have to be **pushed from your server**, not scheduled on-device.

**Native Focus state.** Unavailable, as above. iOS quiet mode relies entirely on calendar
evidence, which is usually enough — the calendar is what most Focus modes key off anyway.

### What this implies architecturally

The extension is a **capture and ambient surface**, not the product. The product is your
backend plus a web app. That ordering is worth committing to now:

- Reminders come from the server. Web Push works in Chrome, Edge, and Firefox everywhere, and
  in Safari on iOS 16.4+ for a home-screen-installed PWA. Native push needs a thin companion
  app with APNs.
- Sync, conflict checking, and habit inference run server-side. They already do — the
  extension holds no tokens, by design.
- A PWA reaches Android and any desktop browser with no store review at all. Extensions are
  the ambient layer for people who live in a browser tab; the PWA is the floor.

Building the extension first was right — it's where the interesting design problems are. But
do not let scheduled delivery depend on it.

## CI

```yaml
jobs:
  check:
    strategy:
      matrix: { os: [ubuntu-latest, windows-latest, macos-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run check        # typecheck + 56 tests + all four builds
```

Windows in the matrix matters specifically because of the stdio bug above — it is invisible
on Linux and macOS.
