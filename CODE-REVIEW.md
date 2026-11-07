# Code review — second pass

Status: `tsc --noEmit` clean under `strict` + `noUnusedLocals` + `noUnusedParameters`
(now covering `server/` as well as `src/`; it previously covered only `src/`).
204 extension tests and 28 helper tests passing, including the schema and the confirm/sync flows
executed against a real Postgres engine. Three real-browser checks run separately:
`npm run e2e:signals` (screen-share/mic detection, 8 checks), `npm run e2e:panel` (suggested-events
panel, 19 checks) and `npm run e2e:apps` (app control against the real helper and a real app, 26 checks).
All four browser targets build. `npm audit`: 0 vulnerabilities.

> **Corrections to earlier passes.** Two items below were recorded as fixed and were not:
> #1 (screen-share detection) and #3 (`events_cache`). Each carries a correction note. Both
> were found only once the code was actually executed.

## Bugs found and fixed this pass

**1. Screen-share detection never worked.** `probeScreenShare()` read `tab.sharingState`,
which is not part of the Chrome extension API — it returns `undefined`, so the check silently
always said "not sharing". Screen share and mic state are only observable from a content
script that wraps `getDisplayMedia`/`getUserMedia`. Replaced with an injected `PageSignals`
interface, which also makes the resolver pure and testable. Added `mic_active` as a source
while I was in there.

> **Correction (fourth pass): this was not actually fixed.** The content script ran in an
> isolated world, so wrapping `navigator.mediaDevices` there never intercepted the page's own
> calls; a real-browser run showed the signal stayed empty. Detection now uses a page-world
> script (`world: "MAIN"`) plus an isolated relay, and `track.stop()` is patched because it fires
> no `ended` event, which is how every call app's Stop button works. Signals are kept per tab,
> combined with OR, and persisted to `storage.session` so a suspended worker does not forget
> an ongoing share. Verified end to end; the same test fails on the old design.

**2. Habit proposals landed in the wrong timezone.** `dateForWeekday()` used
`setHours`/`getDay`, which run in the *server's* zone. On a UTC container, a Los Angeles
user's 7:00 PM dinner pattern would have been proposed at noon. Now resolves wall-clock time
in the user's zone via `Intl`, and `stageProposals()` takes the timezone explicitly.

**3. `events_cache` did not exist.** The conflict checker queried a table the schema never
created — every conflict check would have thrown at runtime. Added, with a GiST index on the
time range so the overlap query it runs is actually served.

> **Correction (fourth pass):** the GiST index added here made `schema.sql` fail to load at
> all, since a `uuid` column has no GiST operator class without the `btree_gist` extension. The
> schema had never been executed, so this went unnoticed. The extension is now created first.

**4. Card redaction matched things that weren't cards.** The digit-run pattern would have
redacted Zoom meeting IDs and order references out of event text. Added a Luhn check.

**5. Test-then-replace on a global regex.** `redactPII` called `re.test()` then
`re.replace()` on the same `/g` regex; `test()` advances `lastIndex`, so the pairing was one
refactor away from skipping matches. Replaced with a compare-after-replace, and `types` is
now a Set so it can't report duplicates.

**6. OCR redaction was cosmetic.** The vision pipeline called `moderateInput`, got back
sanitized text, and then stored the *original* fields anyway. A card number photographed on a
form would have been "redacted" in name only. Now the sanitized values are what get stored,
with a note added to the event's assumptions.

**7. `chrome?.runtime` throws.** Optional chaining does not guard an *undeclared* identifier,
so opening `sidepanel.html` outside an extension threw a ReferenceError on the toggle. Now a
`typeof` guard. Also dropped `export` from an inline module script, added `type="button"` to
the switch, and gave it Space/Enter handling.

**8. Unguarded `JSON.parse` in the prep audit.** A prose response from the model threw
straight into the panel's render path. Now raises `AuditUnavailableError`, which the caller
can degrade on — a missing prep card is a nicety, not a failure.

## Fixed in the previous pass

**9. Exam vs. meeting tiebreak.** Both resolve to `silent`, and the reducer kept whichever
came first, so a back-to-back meeting and exam could label the exam "you're in a meeting" —
and that label gates exam-content lockout in the prompt. Added `SOURCE_PRIORITY`.

**10. Lost capitalisation.** Stripping "Make sure you " left "have the Zoom link" lowercase
in the panel.

## Third pass — cross-platform

**11. Windows native messaging was corrupt on some payloads.** The host used text-mode
stdio. Native messaging frames a 4-byte little-endian length ahead of the JSON; Windows
rewrites `\n` as `\r\n`, so any frame containing a `0x0A` byte was mangled. It would have
presented as the host failing intermittently on Windows only, depending on payload length.
Now forces binary mode via `msvcrt.setmode` before any byte moves.

**12. The host exited after one message.** Browsers may keep a native host alive across
several queries. It now loops.

**13. Linux DND reported a mode name while inactive.** Returned `focus_active: False` with
`mode_name: "Do Not Disturb"`, which would have rendered as a contradiction in the panel
header.

**14. Firefox would have installed and done nothing.** The manifest shipped
`background.service_worker`, which Firefox MV3 does not support — it uses non-persistent
event pages. It also lacked a `browser_specific_settings.gecko.id`, without which it refuses
to install at all. Both handled in `src/platform/manifest.ts`, with 11 tests over the four
target shapes.

## Reviewed, deliberately unchanged

- `auto_commit_enabled` stays pinned false by a CHECK constraint. Removing it should require
  a migration someone signs off on.
- `moderateInput`'s classifier fails open on the non-crisis categories. Failing closed on every
  category would make an API blip look like a refusal loop. It fails closed in exactly one case:
  the literal pass saw a crisis phrase and the classifier that would clear it is unavailable.
- The `payment_card` pattern still won't catch a card typed with unusual separators. Accepted
  — the alternative is redacting real event text, which is the worse failure.

## Fourth pass — security (baseline: the protocols Cognivate shipped to the App Store)

**15. Users could escape an org's no-adaptive policy and read other orgs' audit logs.** The
`own_settings` policy was `for all` with no column limits, so a user could set `org_id = null`
(shedding the org policy), set `tier = 'enterprise'`, or join any org, and
`org_admin_reads_audit` checked membership rather than an admin role. Column grants now withhold
`org_id`, `tier`, `org_role`, `ai_consent_at` and row deletion from client roles; the audit policy
requires `org_role = 'admin'`; and the toggle cannot be switched on where org policy forbids it.
Covered by `test/schema.test.ts`, which fails on 9 checks when the fix is removed.

**16. The crisis literal pass had holes.** "I'm going to ..." never matched (the pattern needed a
space after `i`); curly apostrophes missed; and a coursework word ("assignment", "essay")
switched the pass off entirely, leaving a classifier that fails open. Patterns moved to
`src/safety/crisisLiteral.ts`; a coursework word now routes to the classifier instead of
suppressing, and an unavailable classifier is treated as a crisis in that case.

**17. No consent before content reached the model provider, and no way to delete.** `/capture`
now requires a recorded, revocable consent (checked in the database on every call) and there is a
`POST /account/delete` that revokes Google refresh tokens and removes every row the user owns.

**18. Server hardening.** Security headers on every response; rate limits (per-IP, per-user for
model calls, and failed-auth lockout since the test token is one shared secret); credentialed CORS
and the cookie-auth fallback removed; image fetches pinned to the validated address (DNS
rebinding) with credentials, odd ports, redirects and private/multicast ranges refused;
`SECURITY DEFINER` functions pin `search_path`; database TLS can be verified via `DATABASE_CA`.

**19. Extension hardening.** The disclosure page is no longer web-accessible (any site could frame
it and clickjack "Continue"); privileged messages are rejected from content scripts; an
unescaped attribute built from event titles (attacker-controlled via invitations) is escaped;
the unused `api.anthropic.com` host permission is gone.

**20. Dependencies.** `zod` (high) and `esbuild` (moderate) upgraded; `npm audit` is clean.

## Fifth pass — closing the loop: confirm, write, sync

**21. A proposal could never become an event, and the calendar cache was always empty.** Capture
staged proposals but nothing wrote them anywhere, and nothing populated `events_cache`, so the
"may the assistant speak" resolver only ever saw the staging-only seed route. Added:
- `POST /proposals/:id/confirm`. It first CLAIMS the proposal (pending -> confirmed) in one
  conditional update and only the request that wins the claim calls the provider, so a double
  tap, a retry or two open panels cannot create two events. A refused or failed write releases
  the claim so the user can retry. A timed event with no end time is refused without calling the
  provider (a duration is never assumed); the user supplies it in the panel.
- `POST /sync`, which mirrors the next week of each connected calendar into `events_cache`, with
  token refresh (including Microsoft's rotating refresh tokens), revoked-grant detection, and a
  guarantee that a provider outage is never mistaken for an empty calendar.
- A "Suggested events" section in the panel: Add, Dismiss, inline pickers for times the extractor
  left blank, and a prompt to choose when two calendars are connected.

**22. Reconnecting the same calendar account failed.** `/oauth/complete` inserted a new connection
and then deleted older ones, but `oauth_connections` is unique on (user, provider, email), so the
insert itself failed the second time anyone connected an account. Now an upsert that also clears
the revoked flag; the disclosure trigger still fires on it.

Verification, deliberately adversarial: the flow tests run real SQL against a fake provider, and
four reintroduced bugs (claim ignoring status, failed write not releasing the claim, plain-insert
reconnect, outage deleting cached events) are each caught by the test aimed at them. The panel
test fails when a title is rendered unescaped and when the "pick an end time" guard is removed.
The extension's CSP also blocked an injected `onerror` handler even when the markup got through.

## Sixth pass — opening and closing apps

**23. New capability: open and close desktop apps from the panel (macOS).** A browser extension
cannot launch programs, so this is a separate native helper (`native-host/app-control.py`), kept
apart from the read-only Focus probe because it can act, and so installed, audited and removed on its
own. Design, in order of importance:
- **Only the user triggers it.** Typed in the panel, or the Open/Close buttons. No web page, calendar
  entry, captured image or AI model can reach it; the command parser is deterministic and never
  sees untrusted text. Privileged messages are already refused from content scripts.
- **Off by default, per-app allow-list.** Enforced in the service worker; a corrupted or hand-edited
  stored list can only shrink what is allowed.
- **Open is immediate; close always asks first**, in the panel, because an app may hold unsaved work.
- **Close is the app's own Quit, never a force-kill**, so it can still ask to save. When an app
  does not close, the panel says it may be waiting on the user rather than claiming success.
- **The helper trusts nothing it is handed.** It acts only on a bundle id it found by scanning the
  installed apps itself, checks the id against a strict pattern before it reaches AppleScript, uses
  argument lists (no shell), refuses to quit browsers/Finder/system UI, and rate-limits itself.
- Windows and Linux report `unsupported_platform` rather than shipping untested launch/quit code.

The first real-browser run failed with "Native host has exited", and the cause is worth keeping:
**macOS does not let a browser-launched program read `~/Documents`, `~/Desktop` or `~/Downloads`**
(`Operation not permitted`), which is where a cloned project lives. Unit tests could never have found
it. The installer now copies the helper to `~/Library/Application Support/AmbientCyberCompanion/`
(mode 755 in a 700 folder) and registers the copy.

Verification: 28 helper tests plus 13 parser tests, with the safety rules mutation-checked (protected
check, id validation in both layers, a force-kill fallback, the rate limit, and the service worker's
close-confirmation each make a test fail when removed). With both id checks removed, a malicious
installed app's bundle id really does reach `osascript`, so each layer has its own test. The browser
suite drove the real panel, the real helper, and launched a real Calculator.

**24. The calendar-choice buttons showed on every suggestion card, all the time.** They are meant to
appear only when two calendars are connected and the server asks which to use. The panel's own CSS
(`display: flex`) overrode the browser's `hidden` attribute, so they were always visible. The
browser test for that flow passed anyway, because it checked that the element existed, not that it
was invisible. Found only by looking at a screenshot taken for the partner deck. Fixed in CSS, and the
test now asserts the buttons are hidden until asked for and visible afterwards (it fails without the fix).
The panel suite is now 19 checks.

## Still unverified or open

- **`db/schema.sql` has run only on PGlite, not on Supabase.** PGlite is faithful for roles, column
  grants, RLS, triggers and CHECKs, with `auth.uid()` and the client roles stubbed and
  `supabase_vault`/`pgcrypto` removed. Run it on a real Supabase project before shipping.
- **The new server routes have not run against a database.** `consent`, `account/delete` and
  `capture` were exercised only in no-database mode (they refuse correctly).
- **No live model calls.** The vision, moderation-classifier, and audit prompts have never
  been run against the real API. They need contract tests over recorded fixtures.
- **No end-to-end OAuth.** The token exchange is written but has never run against Google or
  Microsoft, and needs the extension's redirect URL registered in each console.
- **Safari ships no screen-share/mic signal.** `world: "MAIN"` support there is unconfirmed, so
  that build reports nothing, which resolves quiet. Firefox and Chromium are configured for it;
  only Chromium has been tested in a browser.
- **A real "close" has never been run.** The first close of any app makes macOS show an "allow this
  browser to control that app" prompt, and a test should not throw a permission dialog at someone.
  Closing is verified up to and including the confirmation step, and the helper's exact
  `osascript` call is asserted in unit tests, but the live round trip is untested. The panel and
  helper name the failure ("permission needed") when that prompt is unanswered.
- **App control is macOS-only, Chromium-tested.** Firefox gets a registration but is untested;
  Safari's extension model has no native messaging, so it has no app control at all.
- **The helper has no per-app memory of consent on its own side.** The allow-list lives in the
  extension. A compromised extension page could ask the helper to open any non-protected app (the
  helper still refuses protected ones, bad ids, and floods). A native macOS confirmation dialog on
  close would close that gap; not built.
- **The provider calls have only run against a fake.** Google and Microsoft request/response
  shapes are written from their documentation and exercised against fakes, never the real services.
  Pagination is not handled (the first 250 events in the window), and all-day events are placed
  at UTC midnight, so they can land on the neighbouring day in far-east/west zones.
- **No retry after a partial failure on confirm.** If the provider creates the event but the
  follow-up write of its id fails, the proposal stays confirmed (a retry is refused, so there is no
  duplicate) but the id is not recorded. Rare, and it errs toward no duplicate.
- **Writes always go to the primary calendar.** There is no calendar picker.
- **The server connects as the database owner**, so RLS does not back up its queries; every query
  filters by `user_id`, and the schema test guards the deletion list. Running requests under a
  non-owner role would add a second layer.
- **Rate limits and OAuth state are per-instance.** Move both to shared storage before scaling out.
- **The IP limiter trusts the last `X-Forwarded-For` entry.** Confirm that is the client address
  on Railway, or one noisy client could lock everyone out of sign-in.
- **The test token sits unencrypted in `chrome.storage.local`.** Staging only; remove with `/dev/events`.
