# Cyber Companion — App Store readiness

Adapted from Cognivate's shipped submission (`docs/cognivate-reference/SUBMISSION.md`, `XCODE.md`,
`DEPLOY.md`). Work top to bottom.

## Done in the repo

- [x] `PrivacyInfo.xcprivacy`: no tracking; collects email, user ID and user content (linked,
      app functionality only); `UserDefaults` reason CA92.1.
- [x] `ITSAppUsesNonExemptEncryption = NO` (standard OS encryption only).
- [x] Sign in with Apple entitlement (`app/CyberCompanion.entitlements`); the button exists in
      `SignInView` and would have failed without it.
- [x] Account deletion in-app (`POST /account/delete`), AI consent + revocation, privacy link.
- [x] Microphone / speech usage strings present; token stored in the Keychain.
- [x] Simulator build passes (unsigned).
- [x] Client hardening (`SecureSession.swift`, `Keychain.swift`, `AppConfig.swift`): no response
      cache or cookie jar, TLS 1.2 minimum, redirects refused unless same host over HTTPS (so the
      Bearer token can't be forwarded elsewhere), Keychain items marked this-device-only, plain HTTP
      accepted in debug builds only. `SecurityTests.swift` covers each; 19 tests pass on the simulator.
- [x] Fixed: `ServerAddress.normalize` accepted `ftp://host` and `https://` as hosts.
- Server-side protections (headers, rate limits, SSRF guards, RLS, consent, deletion) were already
  in `server/`; see CODE-REVIEW.md passes 4-5.
- Not done: certificate pinning (Cognivate does not pin either; it breaks on certificate rotation).
- **Signing:** the Sign in with Apple entitlement means any signed build now needs a Team set
  (Signing & Capabilities) or Xcode reports "entitlements that require signing with a development
  certificate". Unsigned/simulator builds still work.

## Connections to set up

| Service | Used for | What you need | Where it goes |
|---|---|---|---|
| Apple Developer Program | Signing, TestFlight, App Store Connect, Sign in with Apple | $99/yr membership, a Team | Xcode > target > Signing & Capabilities |
| Railway | Hosts `server/` (`railway.json`, health check `/health`) | Project + domain (e.g. `api.cybercompanion.app`) | `AppConfig.serverURL` |
| Supabase | Auth + Postgres (`db/schema.sql`, `db/migrations/`) | Project URL, anon key, JWT secret, DB URL, DB CA cert | App: `AppConfig.supabaseURL` / `supabaseAnonKey`. Server: `DATABASE_URL`, `DATABASE_CA`, `SUPABASE_JWT_SECRET` |
| Anthropic API | Capture, moderation, vision, audit | API key | Server only: `ANTHROPIC_API_KEY` |
| Google Calendar (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`) | Calendar connect/sync | OAuth client in Google Cloud Console, redirect URI registered | Server: `GOOGLE_CLIENT_ID/SECRET` |
| Microsoft (`login.microsoftonline.com`, `graph.microsoft.com`) | Calendar connect/sync | App registration in Entra, redirect URI registered | Server: `MICROSOFT_CLIENT_ID/SECRET` |
| Netlify (`api.netlify.com`) | Publishing user websites | None for you; each user connects their own account | `action_connections` table |
| Bluesky (`bsky.social`) | Promotion drafts | None for you; per user | `db/migrations/001_bluesky_provider.sql` |

Also generate `MASTER_KEY` (32 random bytes, base64) for OAuth token encryption. Never put the
Supabase service-role key or any `.env` value except the anon key in the app.

## Before first archive

1. Fill `AppConfig.swift` (server URL, Supabase URL, anon key). While nil, release builds depend on
   Settings > Advanced, which reviewers will not fill in.
2. Set Team in Signing & Capabilities; confirm Sign in with Apple capability appears.
3. Run `db/schema.sql` + migrations on a **real Supabase project** (only PGlite so far).
4. Deploy the server to Railway; confirm `/health`, then `/consent/ai`, `/capture`,
   `/account/delete` against the real database (never run against one yet).
5. Remove the staging `TEST_ACCESS_TOKEN` path from production variables.
6. Confirm Railway's client-IP header handling (see CODE-REVIEW.md, "Still unverified").
7. Run the model prompts once against the live API.
8. Bump `CURRENT_PROJECT_VERSION` for every upload.

## App Store Connect

- **Privacy policy URL**: host at `<server>/privacy`. It must disclose Anthropic receiving captured
  content, Google/Microsoft calendar access, and Supabase storage. Email and account IDs are not
  sent to Anthropic.
- **App Privacy answers**: Email Address, User ID, Other User Content; all linked, none used for
  tracking, purpose App Functionality. Declare Anthropic as a third-party recipient of content.
- **Export compliance**: uses encryption, exempt (matches the Info.plist key).
- **Age rating**: complete the questionnaire; the app has an AI model and a crisis-handling path,
  so answer the AI/mental-health questions honestly.
- **Reviewer account**: create a demo account with a connected calendar and a sample proposal,
  and put credentials in the review notes. Explain that voice runs on device and that every
  AI action requires prior consent and per-item approval.
- **Guideline 5.1.2(i)**: consent screen before content goes to the AI provider (already built).
- **Guideline 4.8**: Sign in with Apple is offered; Google/Microsoft are calendar connections, not
  app sign-in.
- **Guideline 5.1.1(v)**: in-app account deletion (already built). Verify it end to end on a device.
- Screenshots (6.9" iPhone at minimum) and a TestFlight pass of the smoke test in
  `docs/cognivate-reference/SUBMISSION.md` section 7, adapted to these screens.

## Known gaps to decide on

- macOS app control (open/close apps) lives in the browser extension, not this iOS app; keep it out
  of the iOS review description.
- The deployment target is iOS/macOS 26.0 — confirm that is the intended minimum.
- Rate limits and OAuth state are per-instance; fine for one Railway instance, not for scale-out.
