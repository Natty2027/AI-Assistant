# Hera — App Store readiness

Adapted from Cognivate's shipped submission (`docs/cognivate-reference/SUBMISSION.md`, `XCODE.md`,
`DEPLOY.md`). Work top to bottom.

## Done

- [x] **Identity:** display name Hera, bundle ID `com.natty2027.hera`, team `ATXR9435HS`; the App ID
      is registered with Sign in with Apple (Xcode's automatic signing did it).
- [x] **Signing:** signed Mac build verified (Program License Agreement accepted).
- [x] `PrivacyInfo.xcprivacy`: no tracking; collects email, user ID and user content (linked,
      app functionality only); `UserDefaults` reason CA92.1.
- [x] `ITSAppUsesNonExemptEncryption = NO` (standard OS encryption only).
- [x] Sign in with Apple entitlement and button; Supabase's Apple provider enabled with client IDs
      `com.natty2027.hera` and `com.natty2027.cybercompanion`.
- [x] Account deletion in-app (`POST /account/delete`, also closes the Supabase sign-in account),
      AI consent + revocation, privacy/terms/support links.
- [x] Microphone / speech usage strings present; token stored in the Keychain (this device only).
- [x] Client hardening (`SecureSession.swift`, `Keychain.swift`, `AppConfig.swift`): no response
      cache or cookie jar, TLS 1.2 minimum, redirects refused unless same host over HTTPS, plain
      HTTP accepted for localhost in debug builds only.
- [x] **Wired up:** `AppConfig.swift` points at Railway
      (`https://ai-assistant-production-e789.up.railway.app`) and Supabase
      (`https://ozleskfpkntrfkzalczf.supabase.co`, publishable key).
- [x] **Server live on Railway** from `main`: `/health` reports the database reachable and AI
      configured; `/privacy`, `/terms` and `/support` serve; unauthenticated calls are refused.
- [x] **Database:** `db/schema.sql` and `001_bluesky_provider.sql` applied on Supabase; tables are
      closed to the public key.
- [x] **Hera's voice:** Kokoro-82M `af_heart` on device (Apache 2.0, credited in Settings → Voice).
- [x] Unused calendar endpoints and browser-extension code removed from the server.
- Not done: certificate pinning (Cognivate does not pin either; it breaks on certificate rotation).

## Connections

| Service | Used for | Where it's set |
|---|---|---|
| Apple Developer Program | Signing, TestFlight, App Store Connect, Sign in with Apple | Xcode > Signing & Capabilities (team `ATXR9435HS`) |
| Railway | Hosts `server/` (`railway.json`, health check `/health`), deploys `main` | Railway Variables (see `.env.example`); volume at `/data` |
| Supabase | Sign-in (Apple) and Postgres | App: `AppConfig.supabaseURL` / `supabaseAnonKey`. Server: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Anthropic API | The assistant (Claude) | Server only: `ANTHROPIC_API_KEY` |
| Netlify (`api.netlify.com`) | Publishing people's websites | None for you; each person connects their own account |
| Bluesky (`bsky.social`) | Publishing approved posts | None for you; each person connects with an app password |

Never put the Supabase service-role key, `MASTER_KEY` or any other server variable in the app.

## Before the first upload

1. Test on a real iPhone: Sign in with Apple, create a site and posts, approve and publish,
   listen to Hera, then delete the account and confirm it's gone in Supabase → Authentication.
2. Make sure `TEST_ACCESS_TOKEN`, `TEST_USER_ID` and `DEV_USER_ID` are not set on Railway.
3. Confirm Railway's client-IP header handling for rate limits.
4. Run `npm run smoke:models` once with the real key.
5. Bump `CURRENT_PROJECT_VERSION` for every upload. Archive with `npm run app:archive` (iPhone and
   Mac; see XCODE-TESTING.md → TestFlight), then upload from Xcode's Organizer.

## App Store Connect

- **New app:** name "Hera: Sites & Posts" (plain "Hera" is taken), bundle ID `com.natty2027.hera`,
  SKU of your choosing (e.g. `hera-001`), platforms iOS and macOS.
- **Privacy policy URL:** `https://ai-assistant-production-e789.up.railway.app/privacy`. It
  discloses Anthropic receiving requests and content, Supabase storage, and Netlify/Bluesky only
  when connected. Email and account IDs are not sent to Anthropic.
- **App Privacy answers:** Email Address, User ID, Other User Content; all linked, none used for
  tracking, purpose App Functionality. Declare Anthropic as a third-party recipient of content.
- **Export compliance:** uses encryption, exempt (matches the Info.plist key).
- **Age rating:** complete the questionnaire; the app uses an AI model, so answer those questions
  honestly.
- **Reviewer account:** a demo account with a sample site and post waiting for approval, with
  credentials in the review notes. Explain that voice input and Hera's voice run on the device and
  that every AI action requires prior consent and per-item approval.
- **Guideline 5.1.2(i):** consent screen before content goes to the AI provider (built).
- **Guideline 4.8:** Sign in with Apple is the sign-in; Netlify and Bluesky are publishing
  connections, not app sign-in.
- **Guideline 5.1.1(v):** in-app account deletion (built). Verify it end to end on a device.
- Screenshots (6.9" iPhone at minimum, plus Mac) and a TestFlight pass of the smoke test in
  `docs/cognivate-reference/SUBMISSION.md` section 7, adapted to these screens.

## Known gaps to decide on

- The deployment target is iOS/macOS 26.0 — confirm that is the intended minimum.
- Rate limits and approval tokens are per-instance; fine for one Railway instance, not for scale-out.
- The calendar tables remain in the database, unused; dropping them is a separate, irreversible step.
