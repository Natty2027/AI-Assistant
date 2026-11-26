# Hera Pro, limits, and keeping work safe across deploys

## Hera Pro (subscriptions)

Each request to Hera (a set of posts, a launch, a listing, a reply) counts as one for the month.
The free plan gets `FREE_REQUESTS_PER_MONTH` (default 20); Hera Pro gets `PRO_REQUESTS_PER_MONTH`
(default 300). Limits are **off** until `BILLING=on`, so nobody is stopped before the
subscription exists. Counting starts as soon as migration 008 is run.

The app shows Apple's own subscription sheet (Settings → Plan → Upgrade, or automatically when a
month's requests run out). Each purchase carries the Hera account id, and the server only gives Pro
after checking the App Store's signature back to Apple's root certificate (`server/billing.ts`).

### Setup

1. **App Store Connect → Agreements, Tax, and Banking:** accept the Paid Apps agreement and add
   bank and tax details (Apple won't sell subscriptions without it).
2. **App Store Connect → your app → Subscriptions:** create a subscription group "Hera Pro" with:
   - `com.natty2027.hera.pro.monthly`, e.g. $9.99 a month
   - `com.natty2027.hera.pro.yearly`, e.g. $79.99 a year (optional)
   Add a display name, description and review screenshot for each. A free trial (an introductory
   offer) is set here too. Prices are yours to choose; the app shows whatever is set.
3. **Supabase SQL editor:** run `db/migrations/008_hera_pro.sql` once.
4. **TestFlight:** purchases there are free sandbox purchases, signed by Apple, so the whole flow
   can be tried before release.
5. **Railway Variables** when ready to charge:
   - `BILLING=on`
   - optional: `FREE_REQUESTS_PER_MONTH`, `PRO_REQUESTS_PER_MONTH`
   - optional: `PRO_PRODUCT_IDS` if you use different product ids (comma separated)

### Not yet

- App Store Server Notifications (renewals and refunds are picked up when the app next opens).
- Family Sharing.

## Which AI model answers

Every mode (Studio, Schedule and Launch Kit) uses Claude Sonnet 5.5 (`claude-sonnet-5-5`) at
medium effort (`MODEL_FOR` in `server/agent/loop.ts`). Prompt caching reuses the tools, system
prompt and conversation between the turns of a run, and several tools asked for in one turn run in
parallel. A launch has up to 40 steps and takes a few minutes.

## Approvals and runs survive deploys

Everything waiting in Review, and finished answers from Hera, are saved in the database
(migration 007) and come back after a restart. Something that was being carried out at the moment
the server stopped is marked failed rather than run twice.

When Railway deploys, the old server stops taking new requests and waits for Hera to finish what
she's doing. Set how long it may wait in Railway Variables:

- `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=900` (15 minutes: plenty for a long launch to finish;
  a launch takes a few minutes, so 300 is also enough)

Run `db/migrations/007_persistent_approvals.sql` in Supabase once.
