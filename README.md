# Personal Cyber Companion (PCC)

**Now an iPhone, iPad and Mac app.** Type or speak what you want, and the assistant builds a
website and writes social posts for it. You review the exact content, and nothing is published
until you approve it. See XCODE-TESTING.md to run it and PLATFORMS.md for what runs where.

```
app/                        SwiftUI app (iOS 26 / macOS 26), on-device voice input
server/agent/               the assistant, its rules, Netlify and Bluesky publishing
docs/SAFE-ACTIONS.md        how acting for people is kept safe
```

---

Unified calendar intelligence over Google Workspace, Microsoft 365, and Canvas/Blackboard
iCal, with multimodal capture (text, voice, photo) and an opt-in habit engine.

Stack: TypeScript / Node 20 / Next.js API routes / Postgres (Supabase) / Anthropic API.
One language across the whole stack because the voice layer (Web Speech, WebRTC) and the
client are JS anyway.

## Repo layout

```
db/schema.sql               Postgres schema, RLS, encryption, toggle-purge trigger
src/safety/systemPrompt.ts  Deliverable 1 — system prompt block, both tiers
src/safety/moderation.ts    Pre-call hooks, crisis interception, post-call checks
src/vision/imageToEvents.ts Deliverable 2 — photo -> strict JSON calendar events
src/adaptive/engine.ts      Deliverable 3 — habit inference gated on the toggle
```

## Two build profiles

Same core, different policy objects. Nothing is forked; `Tier` selects a config.

|                        | Personal                    | Enterprise                          |
|------------------------|-----------------------------|-------------------------------------|
| Tenancy                | Single user, one project    | Org-scoped, per-tenant key material |
| Key management         | Supabase Vault              | External KMS (AWS KMS / GCP KMS)    |
| Audit                  | Minimal safety counters     | Full immutable audit log, exportable|
| Habit toggle default   | OFF                         | OFF, plus org policy can force OFF  |
| Auto-commit to calendar| Never without confirmation  | Never without confirmation          |
| Data residency         | Single region               | Per-tenant region pinning           |
| Retention              | User-controlled             | Org retention policy, legal hold    |

Auto-commit is "never" in both tiers on purpose. See the disclaimer rationale below.

## Three constraints worth naming before you build

**1. "End-to-end encryption" is not achievable for the calendar tokens.** The server has to
decrypt OAuth refresh tokens to sync calendars while the user's device is offline. What this
schema actually implements is envelope encryption at rest: per-row data keys wrapped by a
KMS master key, decrypted only inside the sync worker, never returned to the client, never
logged. Call it that in your privacy policy. Claiming E2EE when a server-side worker holds
plaintext tokens is the kind of thing regulators and security researchers check first.

True E2EE is possible for the *habit profile* and free-text notes, since only the client
needs to read those. The schema keeps those columns separate so you can move them behind a
client-held key later without a migration.

**2. Regex crisis detection alone will fail in both directions.** It misses paraphrase and
fires on song titles, coursework ("read Plath for Thursday"), and dark humor. The moderation
layer here is two-stage: a cheap high-precision literal pass for unambiguous phrases, then a
semantic classifier. Even so, treat it as a floor, not a guarantee, and design the UI so a
false positive is a soft, dismissible surface rather than a locked screen.

A calendar app is also not a mental health product. The correct behavior is to stop the
scheduling task, surface real resources, and get out of the way — not to counsel.

**3. Compliance scope is wider than it looks.** Canvas/Blackboard feeds carry education
records, which puts you in FERPA territory when you contract with a school. Calendar contents
routinely include medical appointments, so enterprise deployments in the US will be asked for
a HIPAA BAA even though you are not a covered entity. EU users trigger GDPR Art. 22 concerns
the moment automated scheduling acts without confirmation — another reason auto-commit stays
off. Anthropic offers a zero-data-retention configuration; enterprise tier should enable it.

## Verification requirement (non-negotiable in the UX)

Every AI-derived event passes through `status = 'pending_confirmation'` before it reaches a
real calendar. Extraction confidence is stored per field and rendered in the confirm sheet.
The disclaimer in `systemPrompt.ts` is not just a legal string — it describes the actual
control flow.

## Setup

```bash
npm i @anthropic-ai/sdk zod @supabase/supabase-js ical.js googleapis @microsoft/microsoft-graph-client
psql "$DATABASE_URL" -f db/schema.sql
```

Env: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `KMS_KEY_ID`, `PCC_TIER=personal|enterprise`.
