# Cognivate — App Store Submission Checklist

Step-by-step list for getting Cognivate iOS through App Store Connect, paired with the code fixes in `fixes/`. Work top to bottom.

## 1. Apply the code fixes

Files in `fixes/` map to the repo as follows. Diff and copy each one into place.

| Fix file | Destination |
|---|---|
| `fixes/api.ts` | `artifacts/cognivate-mobile/lib/api.ts` |
| `fixes/clerk.ts` | `artifacts/cognivate-mobile/lib/clerk.ts` *(this one is the original — confirmed correct; copy only if you previously changed it)* |
| `fixes/_layout.tsx` | `artifacts/cognivate-mobile/app/_layout.tsx` |
| `fixes/ConfigError.tsx` | `artifacts/cognivate-mobile/components/ConfigError.tsx` *(new file)* |
| `fixes/AiConsentModal.tsx` | `artifacts/cognivate-mobile/components/AiConsentModal.tsx` *(new file — required for Apple Guideline 5.1.2(i))* |
| `fixes/account.tsx` | `artifacts/cognivate-mobile/app/account.tsx` |
| `fixes/account-delete.tsx` | `artifacts/cognivate-mobile/app/account/delete.tsx` *(new file — create `app/account/` directory)* |
| `fixes/sign-in.tsx` | `artifacts/cognivate-mobile/app/sign-in.tsx` |
| `fixes/sign-up.tsx` | `artifacts/cognivate-mobile/app/sign-up.tsx` |
| `fixes/app.json` | `artifacts/cognivate-mobile/app.json` |
| `fixes/upload.tsx` | `artifacts/cognivate-mobile/app/env/[id]/upload.tsx` |
| `fixes/tutor.tsx` | `artifacts/cognivate-mobile/app/env/[id]/tutor.tsx` |
| `fixes/quizzes.tsx` | `artifacts/cognivate-mobile/app/env/[id]/quizzes.tsx` |
| `fixes/study.tsx` | `artifacts/cognivate-mobile/app/env/[id]/study.tsx` |
| `fixes/quiz-quizId.tsx` | `artifacts/cognivate-mobile/app/env/[id]/quiz/[quizId].tsx` |
| `fixes/env-id-index.tsx` | `artifacts/cognivate-mobile/app/env/[id]/index.tsx` |
| `fixes/index.tsx` | `artifacts/cognivate-mobile/app/index.tsx` |
| `fixes/aiRateLimit.ts` | `artifacts/api-server/src/middlewares/aiRateLimit.ts` |
| `fixes/analyze.ts` | `artifacts/api-server/src/lib/analyze.ts` |
| `fixes/storage.ts` | `artifacts/api-server/src/routes/storage.ts` |
| `fixes/environments.ts` | `artifacts/api-server/src/routes/environments.ts` |

Then run from the repo root:

```bash
# Manual edit: remove "expo-location" line from artifacts/cognivate-mobile/package.json
pnpm install
pnpm run typecheck
```

If typecheck reports errors, see the "Known typecheck risks" section below.

## 2. Set build-time environment variables

In Replit Expo Launch, set these as build-time secrets:

| Var | Value | Why |
|---|---|---|
| `EXPO_PUBLIC_DOMAIN` | Your production Autoscale domain (e.g. `cognivate-prod.replit.app`) | Mobile app reads this in `lib/api.ts` and `lib/clerk.ts`. Without it, the app shows `ConfigError` at launch. |

`EXPO_PUBLIC_*` vars are baked into the JS bundle — set them as build-time, not runtime. They are not secrets in the cryptographic sense.

## 3. iOS 26 SDK requirement (CRITICAL — already in effect)

Starting April 28, 2026, App Store Connect rejects builds that aren't compiled against the iOS 26 SDK or later. Today is past that date.

- **Expo SDK 54 supports iOS 26 SDK** — confirmed in the Expo SDK 54 release notes (Sep 10, 2025).
- **Replit Expo Launch must build with Xcode 26.** Confirm with Replit support that their build image is on Xcode 26. If they're still on Xcode 16, your submission will be rejected at upload.

## 4. App Store Connect configuration

### App Privacy questionnaire

Cognivate collects only what's needed. Answers:

- **Contact Info → Email Address**: Yes, collected.
  - Linked to user: **Yes**
  - Used for tracking: **No**
  - Purposes: **App Functionality** (sign-in)
- **User Content → Other User Content**: Yes, collected.
  - This covers uploaded PDFs, slides, photos, AI-generated study materials, and tutor messages.
  - Linked to user: **Yes**
  - Used for tracking: **No**
  - Purposes: **App Functionality**
- **Identifiers → User ID**: Yes, collected (Clerk user ID).
  - Linked to user: **Yes**
  - Used for tracking: **No**
  - Purposes: **App Functionality**
- Everything else: **Not collected.**

**Third-party data sharing — declare Anthropic:** In the App Privacy section, when asked about sharing data with third parties, declare:
- **Anthropic** (the maker of Claude) receives uploaded file contents (text and images extracted from PDFs, slides, notes, photos) and tutor messages for the purpose of generating study materials.
- Email addresses and account identifiers are **not** sent to Anthropic.

### Encryption export compliance

- **Does your app use encryption?** Yes
- **Does it qualify for the encryption exemption?** Yes (uses only standard encryption within Apple's OS)
- **Is your app exempt from US export regulations?** Yes

Must agree with `ITSAppUsesNonExemptEncryption: false` in `app.json`.

### Age rating

Recommended rating: **4+**. The app is upload-driven; the student supplies content. The AI tutor is grounded in user uploads.

### Review notes (Apple reviewer)

Put this in the "Notes" field of the submission:

```
Cognivate is a personal AI study tool. Students upload their own materials
(PDFs, slides, notes, photos) and the app generates a private study
environment: dashboard, AI tutor, vocab/formula library, and quizzes —
all grounded in the student's own uploads. Every generated study item is
labeled with whether it came directly from the source or was AI-derived.

DEMO ACCOUNT
  Email: <create a demo account in Clerk and put it here>
  Password: <demo password>
  This account has one pre-loaded study environment with a sample PDF
  so the reviewer can see the full flow without uploading anything.

AI DATA SHARING (Guideline 5.1.2(i), revised Nov 2025)
  Cognivate sends uploaded file contents and tutor messages to
  Anthropic (the maker of Claude) to generate study materials. The
  user is asked for explicit consent on first upload via an in-app
  modal ("Cognivate uses AI to build your study environment"). The
  user can revoke consent at any time from the Account screen ("AI
  processing → Stop"). Email addresses and account identifiers are
  NEVER sent to Anthropic.

ACCOUNT DELETION (Guideline 5.1.1(v))
  In-app: Account screen (tap the person icon top-right of Library)
    → "Delete account" → type DELETE → "Permanently delete account".
  This calls DELETE /account on our server, which cascade-deletes every
  environment, file, quiz, vocab/formula entry, highlight, and tutor
  message belonging to the user, plus their object-storage blobs. It
  then deletes the Clerk authentication account itself.

PERMISSIONS
  Camera + Photo Library: only for the user to add photos of notes,
    slides, or textbook pages to their own study environment.
  Documents: only for the user to import PDFs/Word/PowerPoint files.
  No location, no contacts, no microphone, no tracking.

CONTACT
  <your support email>
```

## 5. Privacy Policy — required and non-optional

Apple rejects without a live, reachable Privacy Policy URL. It MUST disclose:

- What data is collected (email via Clerk; user-uploaded content; user-generated content like quiz attempts and tutor messages)
- That uploaded content and tutor messages are sent to Anthropic for processing
- That Anthropic processes the data to generate study materials and does not train its models on API content (per Anthropic's commercial API terms — verify the current terms before publishing)
- How long data is retained
- How users can delete their data (in-app + via contacting support)
- Cookies / tracking — there are none for this app
- Children's privacy — if the app is intended for users under 13, COPPA applies. The current consent flow assumes users are old enough to consent themselves; consider an age gate or marking the app as not for children under 13.

Host this on a stable URL and put it in App Store Connect's "Privacy Policy URL" field plus your in-app footer.

## 6. Required assets

Upload via App Store Connect web UI:

- **App icon**: already in build (`assets/images/icon.png`, 1024×1024 RGB no alpha).
- **Screenshots**: minimum one set for 6.7" or 6.9" display (1290×2796 or 1320×2868). Recommended: Library, env dashboard, tutor chat, quiz, vocab. Use real TestFlight screenshots. **No emojis.**
- **App preview video** (optional): 15–30 sec.
- **App name**: Cognivate
- **Subtitle**: e.g. "Personal AI study tool"
- **Promotional text**: 170-char short blurb (can be changed without resubmission)
- **Description**: long-form description
- **Keywords**: 100-char comma-separated
- **Support URL**, **Marketing URL**, **Privacy Policy URL**: all must be live.

## 7. TestFlight smoke test

Build via Replit Expo Launch with `EXPO_PUBLIC_DOMAIN` set. Install on a real iPhone via TestFlight.

Test sequence (the reviewer will test something close to this):

1. **Cold launch** → sign-in screen appears (no ConfigError, no white screen).
2. **Sign up** with a new email → verification code → land on Library.
3. **Create new env** → name it → "Add files".
4. **Tap "Choose document"** → AI consent modal appears the first time. Tap "Allow AI processing".
5. **Pick a PDF** → wait for analysis status to flip from "Analyzing…" to file count.
6. **Open env** → see stats grid populate.
7. **Tap "Ask the tutor"** → ask a question → get a response.
8. **Tap "Take a quiz"** → "Generate new quiz" → answer questions → submit → see score.
9. **Library → account icon → AI processing → "Stop"** → confirm. Try to upload again → consent modal should reappear.
10. **Account → "Delete account"** → type DELETE → confirm. Sign-in screen reappears. Try to sign in again with same email → fails (account gone).

**Edge cases to test on device** (these are the ones I couldn't verify statically):

- Upload a 20MB+ PDF (just under the 25MB cap). Verify it completes and doesn't OOM.
- Background the app mid-upload. Resume. Verify upload either completes or fails gracefully.
- Swipe-dismiss the account-delete modal mid-flight. Verify no crashes.
- Tap "Permanently delete account" twice rapidly. Verify only one delete fires.

## 8. Known typecheck risks

If `pnpm run typecheck` errors:

- **`mediaTypes: ['images']`** in `upload.tsx`: expo-image-picker v17 should accept this. If TS complains, try `as ImagePicker.MediaType[]` or `[ImagePicker.MediaType.Images]`.
- **`as any` on `query: { enabled: ... }`**: load-bearing because the orval-generated `UseQueryOptions` requires `queryKey`. Don't remove these.
- **Workspace project references**: `tsc -b` from the root should handle `composite: true`. If "file is not under rootDir" errors, run `pnpm run typecheck:libs` first.

## 9. Known limitations to flag in roadmap

These don't block submission but you should know about them:

- **Open-response quiz grading is not implemented server-side.** `routes/ai.ts:243-251` only grades multiple-choice. Text answers are recorded but always count as wrong. Mobile UI now has a TextInput for them, so users can type, but they'll see "Incorrect" for everything. Fix server-side grading before promising open-response in marketing.
- **Large-file uploads use `fetch().blob()`**, which loads the entire file into JS memory. The 25MB cap prevents OOM in most cases, but the canonical RN pattern for production uploads is `expo-file-system`'s `uploadAsync`. Migrate if you raise the cap.
- **AI rate limit is in-memory per-server-instance.** On Replit Autoscale with multiple instances, the limit is effectively N×20/min per user where N is the number of running instances. Move to Redis or DB-backed for accurate limiting at scale.
- **No `queryClient.invalidateQueries` after quiz submit.** Returning to the quiz list shows stale `lastScore` until pull-to-refresh.

## 10. After approval

- Bump `ios.buildNumber` in `app.json` for every subsequent TestFlight or App Store upload (Apple rejects duplicate `CFBundleVersion`).
- Bump `version` only for user-visible releases.
- Update `replit.md` to reflect the rate-limit change from "20/min/IP" to "20/min/user" (S1).

---

## Verified before submission

- [x] FK cascade-delete chain verified end-to-end (`lib/db/src/schema/cognivate.ts` → all child tables `onDelete: "cascade"`)
- [x] Storage access verified ACL-scoped via `environments.userId` join
- [x] No third-party social login → Sign in with Apple not required
- [x] No tracking SDKs → ATT not required
- [x] No `console.*` in `artifacts/api-server/`
- [x] App icon 1024×1024 RGB no alpha
- [x] All `NSUsageDescription` strings present and user-meaningful
- [x] `ITSAppUsesNonExemptEncryption: false` set
- [x] `buildNumber` added to `app.json`
- [x] Subject detection stays dynamic (`analyze.ts` system prompt)
- [x] No emojis in UI
- [x] OpenAPI `info.title` untouched
- [x] Bundle identifier `com.cognivate.mobile` untouched
- [x] No EAS / `app.config.ts` / `prebuild` introduced
- [x] AI consent flow added (Guideline 5.1.2(i), Nov 2025)
- [x] AI consent revocation available in Account screen
- [x] Account-delete double-tap and unmount races guarded
- [x] Sign-in / sign-up double-tap races guarded
- [x] Error empty states distinguish from no-data on all list screens
- [x] 25MB upload cap to prevent OOM on real devices

## Still on your side (cannot be done from code review)

- [ ] Set `EXPO_PUBLIC_DOMAIN` in Replit Expo Launch build secrets
- [ ] Remove `"expo-location": "~19.0.8"` from `artifacts/cognivate-mobile/package.json` line 38
- [ ] Run `pnpm run typecheck` from repo root and resolve any errors
- [ ] Confirm with Replit that Expo Launch builds with Xcode 26
- [ ] Write and host the Privacy Policy disclosing Anthropic data sharing
- [ ] Create a demo Clerk account with one pre-loaded study env for the reviewer
- [ ] Take TestFlight screenshots for App Store Connect
- [ ] Run the on-device smoke test in section 7
