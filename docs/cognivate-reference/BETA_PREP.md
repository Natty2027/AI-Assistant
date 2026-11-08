# Cognivate — External Beta Submission Prep

Everything you need to submit Build 1.0.0 (3) for Beta App Review and
open external TestFlight to your beta testers.

Order matters. Steps before "Submit" must all be done first or Apple will
bounce the build and you'll wait another 24h to re-submit.

---

## Pre-flight verification (already done by me)

| Check | Status |
|---|---|
| Build 1.0.0 (3) uploaded to App Store Connect via EAS | ✅ |
| Build picked up the corrected `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (direct dev URL, no proxy) | ✅ |
| `https://cognivate.co/privacy` returns HTTP 200 with the policy | ✅ |
| `https://cognivate.co/api/healthz` returns 200 `{"status":"ok"}` | ✅ |
| `https://cognivate.co/api/environments` returns 401 (auth-gated, fast) | ✅ |
| TLS cert valid through Aug 19, 2026 | ✅ |
| `pnpm run typecheck` passes across all workspaces (after restoring `src/pages/privacy.tsx`) | ✅ |
| Account deletion flow (Guideline 5.1.1(v)) implemented | ✅ |
| AI consent modal (Guideline 5.1.2(i)) implemented with explicit Anthropic disclosure | ✅ |
| Sentry crash reporting active | ✅ |

---

## 1. Fix the App Privacy questionnaire (REQUIRED before submitting)

You started this earlier but four items got checked by mistake. Apple's
reviewer will compare what you declared against what the app actually
does — overstating data collection is a rejection risk.

Go to **App Store Connect → Cognivate → App Privacy** and **remove**:

- ❌ **Customer Support** (under User Content) — you don't have a support ticket feature
- ❌ **Phone Number** (under Contact Info) — Clerk uses email, not phone
- ❌ **Payment Info** (Financial Info) — no IAP yet
- ❌ **Other Diagnostic Data** — Sentry only collects standard crash + perf

Then for the remaining declared items, for each one click **Edit** and confirm:

| Data Type | Linked to identity? | Used to track? | Purposes |
|---|---|---|---|
| Photos or Videos | ✅ Yes | ❌ No | App Functionality |
| Audio Data | ✅ Yes | ❌ No | App Functionality |
| Other User Content | ✅ Yes | ❌ No | App Functionality |
| Name | ✅ Yes | ❌ No | App Functionality |
| Email Address | ✅ Yes | ❌ No | App Functionality |
| User ID | ✅ Yes | ❌ No | App Functionality |
| Product Interaction | ✅ Yes | ❌ No | App Functionality + Analytics |
| Crash Data | ✅ Yes | ❌ No | App Functionality + Analytics |
| Performance Data | ✅ Yes | ❌ No | App Functionality + Analytics |

For all nine: **uncheck "Other Purposes"** if it's still checked.

Click **Publish** once the summary screen reflects exactly the table above.

---

## 2. Set up Privacy Policy URL

App Store Connect → Cognivate → App Privacy:

**Privacy Policy URL:**
```
https://cognivate.co/privacy
```

Click **Edit** next to "Privacy Policy URL", paste, save.

---

## 3. Set up support@cognivate.co (Email Routing)

Apple's Beta App Review (and testers) need a reachable contact email.
`support@cognivate.co` is referenced in your privacy policy and the app.

The fastest path is Cloudflare Email Routing, since `cognivate.co` is
already on Cloudflare:

1. https://dash.cloudflare.com → cognivate.co → **Email** → **Email Routing**
2. Click **Get Started**. Cloudflare adds the required MX + TXT records automatically
3. Under **Destination addresses**, add and verify your real Gmail
   (`johbson19962@gmail.com`)
4. Under **Custom addresses**, add:
   - `support@cognivate.co` → forward to your Gmail
5. Test: send an email from another account to `support@cognivate.co` — it should hit your Gmail within ~30s

---

## 4. Create a demo account for the Apple reviewer (REQUIRED)

Without this, Beta App Review will reject the build. Apple's reviewer
needs to sign in to test the app.

**Steps (DONE on 2026-05-22):**

1. Signed up on the iPhone TestFlight build with:
   - Email: `johbson19962+cognivatebeta@gmail.com` (Gmail plus-alias — routes to the same Gmail inbox; no separate Cloudflare address needed)
   - Password: stored in iPhone Notes ("Cognivate App Review Demo")
2. Tapped through the AI consent modal and tapped **Allow AI processing** so the reviewer does not have to.
3. Demo account Library is intentionally **empty** — reviewer will upload their own PDF as part of testing the upload flow. (See §6 reviewer notes — they now explicitly instruct the reviewer to do this.)

> Trade-off accepted: leaving Library empty means the reviewer must perform
> an upload themselves to see anything generated, which adds a 30-90 second
> wait and a small risk of upload glitch during their session. If that
> happens we just re-submit with a populated demo and lose ~24 hours.

---

## 5. Draft App Store Connect copy

### Promotional Text
*(≤170 chars, editable anytime without a new build — worded as a patch / "what's new" note)*

```
This update speeds up dashboard generation, smooths uploads, and sharpens tutor replies—turn any PDF or notes into summaries, quizzes, and an AI tutor.
```

### Beta App Description
*(Shown to external testers in the TestFlight app before they install)*

```
Cognivate turns your study materials into a personalized learning environment.

Upload a PDF, lecture slides, or notes, and Cognivate (powered by Anthropic's Claude) generates a dashboard with summaries, vocabulary, formulas, quizzes, and an AI tutor that knows your material.

This beta is our first external release. We want feedback on the upload experience, the quality of generated study materials, the tutor responses, and anything that feels broken or confusing.

Please report bugs via the TestFlight feedback button (shake your device or tap Send Beta Feedback inside TestFlight).
```

### What's New in This Version
*(Release notes / "What's New" field — worded as a patch)*

```
What's new in this build:
• Faster study-dashboard generation after upload
• Smoother PDF, slide, and photo uploads with fewer stalls
• Sharper, more on-topic AI tutor replies
• Clearer AI-processing consent screen on your first upload
• Added account deletion from the Account screen
• Stability fixes and crash reporting improvements

Thanks for testing Cognivate! Send feedback via the TestFlight "Send Beta Feedback" button or email support@cognivate.co.
```

### Email (Beta Feedback)

```
support@cognivate.co
```

### Marketing URL *(optional, public-facing — links from your App Store listing later)*

```
https://cognivate.co
```

(Once the web client deploys, this will show the landing page. For
now it 404s — leave blank for the beta if you want to skip the
empty-page look, or fill in once the web is up.)

---

## 6. Test Information for Apple Reviewer (CRITICAL)

This is the most common reason Beta App Review rejects a build. Apple's
reviewer needs to know exactly how to test your app and what credentials
to use.

App Store Connect → TestFlight → **Test Information**:

### Sign-in required: YES

### Demo account
- Email: `johbson19962+cognivatebeta@gmail.com`
- Password: *(stored in iPhone Notes — paste from there into App Store Connect)*

### Notes for App Review

```
Thank you for reviewing Cognivate.

OVERVIEW
Cognivate is an AI-assisted study app. Users upload study materials (PDFs, slides, notes, photos of textbook pages) and the app generates a personalized study dashboard: summaries, vocabulary, formulas, quizzes, and an AI tutor.

HOW TO TEST
1. Sign in with the demo account credentials above. The Library screen will be empty on first sign-in — this is expected for a fresh review account.
2. Tap the "+" button (or "New environment") on the Library screen to create a new study environment.
3. Give it any name (e.g., "Test") and upload any PDF, slide deck, or photo. A 1-2 page document works best; analysis takes 30-90 seconds.
4. When the dashboard appears, explore the Sections, Vocabulary, Formulas, and Highlights tabs to see the AI-generated study materials.
5. Try the Quizzes tab to take a sample quiz generated from the upload.
6. Try the Tutor tab to ask a question about the uploaded material — the AI tutor responds based on what you uploaded.

AI / THIRD-PARTY DATA SHARING (Guideline 5.1.2(i))
Cognivate sends user-uploaded study materials and tutor questions to Anthropic (Claude) for AI processing. The user is presented with an explicit consent modal before any AI processing occurs, and consent can be revoked at any time from the Account screen. This is disclosed in the Privacy Policy at https://cognivate.co/privacy.

ACCOUNT DELETION (Guideline 5.1.1(v))
The Account screen has a "Delete account" option that removes all user data within 30 days, including study materials, quizzes, and the Clerk authentication account. Confirmation requires typing "DELETE".

CONTACT
support@cognivate.co
```

### Contact Information
- First Name / Last Name: *your real name*
- Phone Number: *your real phone — Apple may call for clarification on rare occasions*
- Email: `support@cognivate.co` (or your personal email — they email here on rejection/approval)

---

## 7. What to Test — for testers (separate from App Review Notes)

App Store Connect → TestFlight → Internal/External Group → **Test Information**
(per-group "What to Test" field):

```
Cognivate v1.0 — first external beta.

Things to try
- Sign up with your email and verify the magic link / OTP works
- Read the AI consent screen on first upload and tap Allow
- Upload a PDF, slide deck, lecture notes, or a photo of a page
- Wait for the dashboard to generate (30-90 seconds), then explore:
   • Sections, Vocab, Formulas
   • Take a quiz
   • Ask the AI tutor a question about the uploaded material
   • Try the Highlighter on a section
- From the Account screen, try Delete Account (don't worry — this only deletes the demo data you just made)

What we want feedback on
- Was the upload flow obvious?
- Did the generated dashboard cover what you'd actually want?
- Was the AI tutor's reply useful and on-topic?
- Did anything crash, hang, or look broken?
- Was anything in the AI consent screen confusing or alarming?

How to give feedback
- Inside TestFlight, tap "Send Beta Feedback" (or shake the device, then tap the screenshot annotation tool).
- Or email support@cognivate.co directly.

Thank you!
```

---

## 8. External Testing setup

App Store Connect → Cognivate → **TestFlight** tab:

1. Left sidebar → **External Testing** → click **+** to create a group
2. Name it something like "Friends & family beta"
3. **Toggle "Enable public link"** — Apple gives you a `testflight.apple.com/join/XXXXXXXX` URL you can DM or post anywhere
4. Set the per-group **What to Test** copy from §7 above
5. Click the group → **Builds** tab → **+ Add Build** → select 1.0.0 (3)
6. Optionally add specific email invites under **Testers** (testers without the public link can be added one by one)

---

## 9. Submit for Beta App Review

After Builds shows 1.0.0 (3) attached to your external group, you'll see
a yellow **Submit for Review** button at the top of the build's page.

- Confirm Export Compliance (already filled in `app.json`:
  `usesNonExemptEncryption: false`)
- Click Submit
- Status will go: **Waiting for Review** → **In Review** → **Approved**
- Approval usually arrives **2-24 hours** for Beta (much faster than full App Review)

When approved, the public link goes live and anyone with it can install.

---

## 10. Known issues / things to NOT panic about

- **The web app at `https://cognivate.co/`** currently 404s. This does not
  affect the iOS beta. The web client isn't deployed yet (separate work).
  Apple's reviewer evaluates the iOS app, not the web app.
- **Clerk is in Development mode.** This works for beta testing but caps
  at 100 users on the Clerk side. We need to migrate to Clerk Production
  before a wider rollout. Not a blocker for Beta App Review.
- **No in-app purchases yet.** No mention of premium / pricing / paywall
  in this build. Monetization is a post-beta phase.

---

## Quick checklist (copy-paste in order)

- [x] Cloudflare Email Routing: `support@cognivate.co` → Gmail (done 2026-05-22)
- [x] Sign up demo account on the iPhone TestFlight build (done 2026-05-22, Library left empty intentionally)
- [ ] App Store Connect → App Privacy: remove the 4 wrong items, edit the 9 correct ones, click **Publish**
- [ ] App Store Connect → App Privacy: set Privacy Policy URL to `https://cognivate.co/privacy`
- [ ] App Store Connect → TestFlight → Test Information: paste the demo credentials + reviewer notes from §6
- [ ] App Store Connect → TestFlight → External Testing: create group, enable public link, paste What to Test
- [ ] Attach build 1.0.0 (3) to the external group
- [ ] Submit for Beta App Review
- [ ] Wait 2-24 hours
- [ ] Share the public link with testers

---

## After Beta App Review approves

- Share the public TestFlight link with your beta testers
- Watch the TestFlight feedback inbox (also forwarded to support@cognivate.co)
- Watch Sentry for crashes. We use ONE Sentry project
  (`cognivate-mobile`) for both surfaces — the same DSN accepts
  events from the React Native client and the Node/Express
  server. Disambiguation in the Sentry UI happens via tags:
    - mobile vs server: filter by `runtime:browser` (mobile JS) or
      `runtime:node` (api-server)
    - production vs v2-preview: filter by `environment` — the
      `appVariant` tag in `_layout.tsx`'s `Sentry.init` sets
      `environment: "v2-preview"` for v2-preview builds and
      `production` otherwise
  Mobile DSN is wired into `eas.json` (`EXPO_PUBLIC_SENTRY_DSN`).
  Server DSN is set as a Replit secret (`SENTRY_DSN`); confirm
  under Replit → Secrets before shipping a new beta build.
- After 1-2 weeks of feedback, we revisit:
  - Monetization (RevenueCat + paywall + AdMob + BYOK — code is parked in `git stash@{0}`)
  - Clerk Production instance migration
  - Web client deployment
  - Real App Store submission (full, not just beta)
