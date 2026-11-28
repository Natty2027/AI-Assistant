# Outlook: one-time setup

Hera can do three things with Outlook:

1. **Outlook calendar** needs no setup here. Hera reads and changes the calendars on the person's
   device, which include an Outlook or Microsoft 365 account added in iPhone Settings → Apps →
   Calendar → Calendar Accounts → Add Account (on a Mac: System Settings → Internet Accounts).
   The app explains this in Accounts.
2. **Open in Outlook**: an email Hera wrote opens in the Outlook app, filled in. No setup either;
   the option appears when the Outlook app is installed.
3. **Send from Outlook, and read the inbox**: the person connects their Microsoft account in
   Accounts. Hera sends an email from it only after the person approves that exact email in the
   app, and reads the inbox only if they turn on "Let Hera read my Outlook inbox". This needs a
   Microsoft Entra app, below. Until its keys are set, the Outlook row and buttons don't appear.

Never paste these keys into chat, the app, or git. They go only into Railway → your service →
Variables.

## 1. The database

In Supabase → SQL Editor, run `db/migrations/010_outlook.sql`. It lets the database store Outlook
connections and the "read my inbox" switch. Running it twice is harmless. Until it's run, every
other account keeps working and Outlook can't be connected.

## 2. Register the app in Microsoft Entra

1. Go to https://entra.microsoft.com (or portal.azure.com → Microsoft Entra ID) and sign in with
   any Microsoft account. Open **App registrations → New registration**.
2. Name: **Hera**.
3. Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID
   tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**. Hera signs in
   through the `common` endpoint, so both work/school and personal Outlook.com accounts can connect.
4. Redirect URI: platform **Web**, address exactly
   `https://ai-assistant-production-e789.up.railway.app/oauth/callback/outlook`
   (that is `<PUBLIC_URL>/oauth/callback/outlook`; it must match `PUBLIC_URL` character for character).
5. Register. On the app's **Overview**, copy the **Application (client) ID**.
6. **Certificates & secrets → Client secrets → New client secret**. Pick an expiry (up to 24
   months; put a reminder in your calendar to make a new one before it runs out) and copy the
   secret's **Value** (not its ID). It's shown only once.
7. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, and add:
   - `offline_access` (stay connected without signing in every hour)
   - `User.Read` (the account's email address, shown in Accounts)
   - `Mail.Send` (send the emails the person approves)
   - `Mail.Read` (read the inbox, only when the person turns it on)

   These are user-consentable: each person approves them on Microsoft's sign-in page. Some work or
   school organizations require an admin to approve apps; their people see a message saying so.
8. Optional but recommended before many people use it: **Branding & properties** (logo, home page
   `PUBLIC_URL`, privacy `PUBLIC_URL/privacy`, terms `PUBLIC_URL/terms`) and publisher
   verification, so the sign-in page doesn't show "unverified".

## 3. Railway Variables

Add, then redeploy:

- `MICROSOFT_CLIENT_ID` = the Application (client) ID
- `MICROSOFT_CLIENT_SECRET` = the client secret's Value
- `PUBLIC_URL` = `https://ai-assistant-production-e789.up.railway.app` (if not set already)

`GET /health` then shows `"outlook": true` under `publishing`, and the Outlook row appears in the
app's Accounts screen.

## How it's kept safe

- Hera can't send anything herself. "Send from Outlook" turns the email the person sees into a
  proposal; it's sent (Graph `POST /me/sendMail`) only after they approve that exact email, by
  its hash, and only once. There's no Bcc: everyone who gets it is on the approval screen.
  At most 10 recipients per email and 20 emails a day per account.
- Reading is off until the person turns it on, per account, and is checked again on every read.
  Everything read is someone else's writing: it's fenced off as data in what Hera sees, it marks
  the conversation as shaped by outside content (so anything she proposes afterwards needs the
  person to confirm they checked it), and Hera saves nothing to memory after it. Addresses found
  in emails can't be used as recipients unless the person gives them.
- Tokens are stored encrypted (envelope encryption with `MASTER_KEY`), refreshed when they expire,
  and deleted when the person disconnects or deletes their account. If Microsoft stops accepting
  them, the account is marked for reconnecting.
