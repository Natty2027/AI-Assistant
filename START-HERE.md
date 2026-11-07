# Cyber Companion

One repo. The earlier split into two projects caused cross-imports that wouldn't resolve;
this is the same code, correctly structured.

```
src/safety/      system prompts, moderation, crisis interception
src/vision/      photo -> structured calendar events
src/adaptive/    habit engine, gated on the privacy toggle
src/providers/   capability matrix and write guard
src/ambient/     quiet-mode resolver
src/prep/        event prerequisites, advisory framing
src/sw.ts        extension background
ext/             manifest, panel UI, icons
db/schema.sql    Postgres: RLS, encryption, toggle purge, disclosure gate
test/            45 tests
```

## Verify before anything else

```bash
npm install
npm run check      # typecheck + 56 tests + all four browser builds
```

`npm run build` emits dist/chrome, dist/edge, dist/firefox, dist/safari.

  Chrome / Edge / Brave / Arc  chrome://extensions -> Load unpacked -> dist/chrome
  Firefox                      about:debugging -> Load Temporary Add-on -> dist/firefox/manifest.json
  Safari macOS + iOS           see XCODE-TESTING.md

Any editor works. See PLATFORMS.md for the full browser/OS matrix.

Open directly in a browser, no build needed:
  ext/ui/sidepanel.html
  ext/ui/connect-disclosure.html

## Read in this order

1. INTEGRATION-REALITY.md   what this can actually do to a real calendar
2. PLATFORMS.md             browsers, operating systems, and the iOS constraint
3. XCODE-TESTING.md         how to run it, and what works without a backend yet
4. ext/ui/README-disclosure.md   where each limitation surfaces, and what enforces it
5. CODE-REVIEW.md           10 bugs found and fixed; what is still unverified
6. README.md, README-ambient.md

## Honest status

Works now: both panels, presence states, the disclosure gate, quiet-mode resolution,
the write guard, all 56 tests. Builds clean for Chrome, Edge, Firefox, and Safari.

Not built yet: the backend. `src/sw.ts` points at `https://api.example.com`. OAuth, calendar
sync, and vision extraction need your token-exchange endpoint before they do anything.

Never executed: `db/schema.sql`. No Postgres was available. Run it and specifically test the
toggle-off purge trigger, `no_write_without_confirmation`, `trg_require_disclosure`, and RLS
from a non-owner role.

## iOS, in one line

Extensions run, but iOS gives them no reliable background lifecycle — scheduled reminders
must be pushed from your server, not scheduled on-device. PLATFORMS.md explains why that
shapes the architecture.
