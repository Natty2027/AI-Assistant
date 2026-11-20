# Scheduled posts, calendar invites, and email reminders

## Scheduled and repeating posts

Ask for a time ("post this Friday at 9", "a post every Monday for a month") and Hera writes each
post with its time. Each one waits in Review; **Approve and schedule** checks it exactly as if it
were going out, then the server holds it and posts it at its time. Approved posts are listed under
**Coming up** in Review, and each can be cancelled until it goes out.

- Every rule is checked again at posting time (daily limits, duplicates), and a post that fails
  them isn't posted; Review says why.
- Only one server posts it, even while two run during a deploy (the database decides).
- Up to 90 days ahead; up to 6 days ahead with a photo (photos are kept for a week).
- Works for X, Bluesky, Facebook and Instagram. Code: `ActionStore.schedule` / `runScheduled` in
  `server/agent/approvals.ts`, checked every minute (`startScheduler` in `server/routes.ts`).
- Needs migration 007 (saved proposals), so scheduled posts survive restarts.

## Calendar invites

- **In emails:** Hera attaches a calendar invite (.ics) to event emails. **Write here** (Apple Mail)
  attaches it; **Share invite** sends the file through Mail, Messages or AirDrop. Guests tap it to
  add the event to Apple, Google or Outlook calendars.
- **On websites:** event pages get an "Add to my calendar" link to an .ics file on the site.
- Launch Kit does both. Code: `server/agent/ics.ts`.

## Email reminders

When an email is for later ("send the reminder Friday morning"), Hera sets its time. **Remind me**
keeps the email on the phone and, at that time, the phone alerts you and Hera says so; tap the
alert and the email opens, ready to send. Nothing is sent by itself.
