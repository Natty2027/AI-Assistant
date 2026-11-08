# Cognivate — Deploy guide

This project deploys to the App Store via **Xcode on your Mac**. The
constraint against ejecting from the managed workflow has been reversed:
this project is now configured for the Expo bare workflow and produces
a real `ios/Cognivate.xcworkspace` you open in Xcode.

**Start here:** [XCODE.md](./XCODE.md) walks the full path from a fresh
`pnpm install` to a build sitting in App Store Connect, step by step.

This file (DEPLOY.md) is the high-level overview. XCODE.md is the
detailed walk-through. SUBMISSION.md is the App Store Connect side.

---

## Overview

```
┌──────────────────────────────────────────────────────────┐
│  Your Mac                                                 │
│  ────────                                                 │
│  1. pnpm install                                          │
│  2. npx expo prebuild --platform ios --clean              │
│  3. cd ios && pod install                                 │
│  4. open ios/Cognivate.xcworkspace                        │
│  5. Configure signing in Xcode                            │
│  6. Press Run (simulator or device)                       │
│  7. Product → Archive → Distribute → App Store Connect    │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│  App Store Connect (web)                                  │
│  ────────                                                 │
│  - TestFlight to verify on real devices                   │
│  - App Privacy questionnaire                              │
│  - Screenshots, description, demo account, review notes   │
│  - Submit for review                                      │
└──────────────────────────────────────────────────────────┘
```

The API server (`artifacts/api-server/`) and web client
(`artifacts/cognivate/`) deploy separately — typically still via Replit,
or any other Node host of your choice.

---

## One-time setup checklist

Before your first Xcode build:

- [ ] macOS 15 (Sequoia) or newer
- [ ] **Xcode 26** installed (required for iOS 26 SDK — App Store deadline
      April 28, 2026 is already past)
- [ ] Node 24 and pnpm 9+ (`brew install node pnpm`)
- [ ] CocoaPods (`sudo gem install cocoapods` if needed)
- [ ] Active Apple Developer Program membership ($99/year)
- [ ] Apple ID added in Xcode → Settings → Accounts
- [ ] `EXPO_PUBLIC_DOMAIN` decided (your production API server domain)
- [ ] DB migration applied to your prod Postgres for the 10 new indexes:
      `pnpm --filter @workspace/db run generate` then apply the SQL
- [ ] Production env vars set on your API server host:
      `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
      `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`,
      `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`)
- [ ] Privacy Policy hosted at a stable URL (must disclose Anthropic
      data sharing — see SUBMISSION.md)

Once those are in place, work through XCODE.md start to finish.

---

## What changed from the original codebase

See CHANGES.md for the per-file diff summary. Highlights you must
account for operationally (full detail in CHANGES.md):

1. **Ejected to bare workflow.** Native `ios/` directory now generated
   from `app.json` via `npx expo prebuild`.
2. **DB migration required** — 10 new indexes.
3. **AI consent flow added** (App Store Guideline 5.1.2(i), Nov 2025).
4. **In-app account deletion** (Guideline 5.1.1(v)) at
   `app/account/delete.tsx`.
5. **HSTS on all API responses** — production must have valid TLS.
6. **Rate limits** on `/api/__clerk` (60/min/IP) and
   `/api/storage/uploads/request-url` (20/min/user).
7. **Anthropic (Claude) calls retry transient failures** up to 3 attempts.
8. **Quiz scoring response shape** — `results` has one entry per
   question now, not per submitted answer.

---

## Database schema — must be pushed manually after schema edits

The repo does not ship migration files. The only sync mechanism is
`drizzle-kit push` (see `lib/db/package.json` `"push"` script). After
ANY edit to `lib/db/src/schema/*.ts`, an operator must run, against
each environment's DATABASE_URL:

```
cd lib/db
DATABASE_URL="<env-neon-url>" pnpm push
```

`push` (non-`--force`) prints the additive diff and asks for
confirmation. **Do NOT run `push-force` against production** unless
the diff is reviewed and contains no column/table drops — `--force`
can drop data.

Drift is loud: `errorHandler.ts` classifies Postgres `42703`
(undefined_column) and `42P01` (undefined_table) as
`schema_drift_detected` and returns HTTP 503 with a clear message,
instead of hiding in the generic `unhandled_route_error` bucket.

To confirm whether a given database is in sync without applying
anything, run the read-only checker:

```
DATABASE_URL="<env-neon-url>" pnpm --filter @workspace/db check-schema-drift
```

Exit code 0 = in sync, 1 = drift. Use this as a CI gate or a
pre-deploy sanity check.

---

## File map

```
/
├── DEPLOY.md              ← high-level overview (you are here)
├── XCODE.md               ← step-by-step Xcode deployment
├── SUBMISSION.md          ← App Store Connect checklist
├── CHANGES.md             ← what changed from the original
├── FEATURE_ROADMAP.md     ← v1.1 / v1.2 / v1.3 plan
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml         ← regenerate on first pnpm install
├── artifacts/
│   ├── api-server/        ← Express 5 + Drizzle backend
│   ├── cognivate-mobile/  ← Expo bare workflow iOS app
│   │   └── ios/           ← generated by `expo prebuild` (after Step 2)
│   └── cognivate/         ← React + Vite web client
└── lib/
    ├── db/                ← Drizzle schema
    ├── api-spec/          ← OpenAPI source of truth
    ├── api-zod/           ← Zod schemas (codegen target)
    ├── api-client-react/  ← React Query client (codegen target)
    └── clerk/             ← shared Clerk helpers
```
