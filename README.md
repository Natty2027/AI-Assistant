# Hera

**An iPhone, iPad and Mac app.** Type or speak what you want, and Hera builds a website and
writes social posts for it. You review the exact content, and nothing is published until you
approve it. Hera reads her replies aloud in a voice made on the device.

See XCODE-TESTING.md to run it and PLATFORMS.md for what runs where.

## Repo layout

```
app/                        SwiftUI app (iOS 26 / macOS 26): on-device voice input and Hera's voice
server/                     Node server the app talks to (Railway): auth, consent, account deletion
server/agent/               the assistant, its rules, Netlify and Bluesky publishing
db/schema.sql               Postgres schema (Supabase), row-level security, encryption
db/migrations/              changes for databases created from an older schema.sql
scripts/mock-app-server.mjs a stand-in server for working on the app without a database or AI key
docs/SAFE-ACTIONS.md        how acting for people is kept safe
docs/APP-STORE-READINESS.md what's done and what's left before submission
```

Stack: SwiftUI, Node 20 + TypeScript, Postgres on Supabase, Claude (Anthropic) on the server,
Kokoro-82M (Core ML) for Hera's voice on the device.

## Setup

```bash
npm install
npm run check             # server: typecheck + tests
npm start                 # needs the variables in .env.example
```

For a new database, run `db/schema.sql` once in the Supabase SQL editor. For one created before
Bluesky publishing existed, also run `db/migrations/001_bluesky_provider.sql`.

## The rule everything rests on

The model proposes; the person approves the exact content; the server carries out only what was
approved. See docs/SAFE-ACTIONS.md for how that is enforced and why each rule exists.

The database still contains tables from the calendar product this project started as
(`events_cache`, `oauth_connections`, `proposed_events` and others). The server no longer reads
or writes them, apart from clearing them when an account is deleted.
