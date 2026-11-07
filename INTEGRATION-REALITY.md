# What this can actually do to a real calendar

Short answer: full read and write — create, move, and delete events in someone's real Google
and Microsoft calendars — is a solved, ordinary integration. It is not surface-level and it
does not require anything exotic. What stands between you and it is OAuth scopes, a platform
review process, and one genuine dead end on the academic side.

## Per provider

| Provider | Read | Write | Scope needed | Real obstacle |
|---|---|---|---|---|
| Google Calendar | Yes | Yes — full CRUD | `.../auth/calendar.events` | Sensitive-scope verification before public launch |
| Microsoft 365 | Yes | Yes — full CRUD | `Calendars.ReadWrite` (delegated) | Tenant admin consent for enterprise orgs |
| Canvas | Yes | Yes, partially | Canvas API token / LTI | Institution must issue a developer key |
| Blackboard | Yes | Mostly no | REST API, institution-issued | Same, and thinner API surface |
| **Any iCal/ICS feed** | Yes | **Never** | — | The format is read-only. There is no write. |

That last row is the one to plan around. The `.ics` subscription URL a student copies out of
Canvas is a one-way export. Nothing can write back through it, ever. If you want to modify a
Canvas assignment or add to a course calendar, you need the institution to issue a developer
key for their instance, which is a per-school conversation with their LMS admin.

So the honest product shape is: **read everything, write to Google and Microsoft, and treat
academic deadlines as read-only facts you schedule *around*.** That's not a limitation worth
apologising for — a student doesn't want to edit a due date anyway, they want study blocks
placed around it, and those blocks land in their personal Google calendar just fine.

## The two things that will actually slow you down

**Google's verification review.** Calendar scopes are classified sensitive. Until you pass
review, your OAuth consent screen shows an unverified-app warning and caps you at 100 test
users. Review takes weeks and wants a privacy policy, a demo video, and a domain you own.
Start it early; it is the long pole, not the code.

**No client secret can live in an extension.** Anything shipped to a user's browser is
readable. Use Authorization Code + PKCE from the extension via
`chrome.identity.launchWebAuthFlow`, and terminate the token exchange and refresh on your own
backend. Refresh tokens never touch the client. This is why `oauth_connections` in
`db/schema.sql` is server-role-only with no client RLS policy — the design already assumes
this.

On iOS, Safari Web Extensions have a much shorter-lived background context than Chrome's
service worker, so scheduled syncs should run server-side and push, not run in the extension.

## Why the current build stops one step short

Nothing here is missing the capability. `proposed_events` deliberately holds a CHECK
constraint that forbids a provider event ID without a prior confirmation, and
`user_settings.auto_commit_enabled` is pinned false by a second constraint. That is a product
decision written into the database, not a gap.

The reason: an assistant that silently writes to a calendar is only as trustworthy as its
worst date-parse. One hallucinated year on a flyer, committed without a human glance, and the
user misses something that mattered. The confirmation tap costs a second and is the thing
that makes the disclaimer honest rather than decorative.

## Activation architecture, for when you want it

When you do turn on autonomous writes, this is the shape — it plugs into the existing
`proposed_events` table without a rewrite:

1. **Provider adapters.** One interface, three implementations:
   `create(event) -> providerEventId`, `update(id, patch)`, `delete(id)`. Google and Microsoft
   only; iCal adapter throws `NotWritable`.
2. **Idempotency keys.** Every write carries a deterministic key derived from the proposal ID
   so a retried sync cannot duplicate an event. This is the single most common failure in
   calendar integrations.
3. **Graduated autonomy, not a single switch.** Per-category thresholds: auto-commit a
   recurring study block the user has confirmed nine times in a row; never auto-commit
   anything involving other attendees, anything derived from an image, or anything within two
   hours of now.
4. **Reversibility window.** Every autonomous write logs the prior state and stays undoable
   from the panel for 24 hours, one tap, no confirmation dialog.
5. **Shadow mode first.** Run the engine for several weeks writing proposals only, and measure
   how often the user accepts them unchanged. If acceptance isn't well above 90% for a
   category, that category isn't ready to be autonomous.
6. **GDPR Article 22.** Automated decisions with significant effect need a human-review path
   in the EU. The undo window plus a per-category opt-out covers it; get it reviewed.

Step 5 is the one people skip. The acceptance rate you measure in shadow mode *is* the answer
to "is this safe to automate", and you get it for free from data you're already collecting.
