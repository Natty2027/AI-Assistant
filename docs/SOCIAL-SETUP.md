# Posting to X, Facebook and Instagram: one-time setup

Hera posts for people through each platform's official API. Each platform needs a developer app
(free to create) whose keys go into Railway Variables. Until a platform's keys are set, its
Connect button in the app shows "Coming soon".

Never paste these keys into chat, the app, or git. They go only into Railway → your service →
Variables.

## 1. The server's public address and the database

1. In Railway Variables, add `PUBLIC_URL` = `https://ai-assistant-production-e789.up.railway.app`
   (no trailing slash).
2. In Supabase → SQL Editor, run `db/migrations/002_x_meta_providers.sql`. It lets the database
   store X, Facebook and Instagram connections. Running it twice is harmless.

## 2. X

1. Go to https://developer.x.com → Developer Portal and sign in. Create a Project and an App.
   Posting needs an API plan that includes posting (`POST /2/tweets`). Check the current plans on the portal.
2. In the app's **User authentication settings**, choose **Set up**:
   - App permissions: **Read and write**
   - Type of App: **Web App, Automated App or Bot** (a confidential client)
   - Callback URI / Redirect URL: `https://ai-assistant-production-e789.up.railway.app/oauth/callback/x`
   - Website URL: `https://ai-assistant-production-e789.up.railway.app`
3. Under **Keys and tokens → OAuth 2.0 Client ID and Client Secret**, copy both into Railway as
   `X_CLIENT_ID` and `X_CLIENT_SECRET`.

Scopes Hera asks for: `tweet.read tweet.write users.read offline.access`.

## 3. Meta (Facebook Pages and Instagram)

Meta only allows posting to **Facebook Pages** (not personal profiles) and to **Instagram
Business or Creator accounts linked to a Page**.

1. Go to https://developers.facebook.com → My Apps → **Create app**. Pick the use case for
   managing Pages / Instagram content (Business app type).
2. Add the **Facebook Login** product. In its settings, under **Valid OAuth Redirect URIs**, add
   `https://ai-assistant-production-e789.up.railway.app/oauth/callback/meta`
3. Permissions Hera asks for: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`,
   `instagram_basic`, `instagram_content_publish`, `business_management`.
4. **App settings → Basic**: copy the App ID and App secret into Railway as `META_APP_ID` and
   `META_APP_SECRET`. Set the Privacy Policy URL to
   `https://ai-assistant-production-e789.up.railway.app/privacy`.
5. While the Meta app is in **Development** mode, only people with a role on it (you, plus anyone
   you add under App roles) can connect. That's enough for testing. To let everyone connect, Meta
   needs **App Review** for the permissions above, plus Business Verification.

## 4. Check

Open `https://ai-assistant-production-e789.up.railway.app/health`. The `publishing` section should
show `"x": true` and `"meta": true`. Then in the app: Accounts → Connect.

## How it works (for reference)

- The app opens the platform's own sign-in page in a secure browser sheet. The platform sends the
  browser back to `/oauth/callback/<x|meta>`. The server swaps the one-time code for tokens and
  stores them encrypted. Then it sends the browser to `hera://connected`, which closes the sheet.
- Photos for posts are uploaded to the server and served at an unguessable
  `PUBLIC_URL/media/...jpg` address, because Instagram downloads the photo itself. They're deleted
  after seven days.
- Nothing is posted until the person approves it in Review.
