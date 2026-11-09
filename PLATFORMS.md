# Platforms

## Where it runs

One SwiftUI app, one codebase (`app/`), and the Node server (`server/`) it talks to.

| Device | Minimum | Layout | Voice input |
|---|---|---|---|
| iPhone | iOS 26 | Tab bar | On-device (`SpeechAnalyzer`) |
| iPad | iPadOS 26 | Sidebar | On-device |
| Mac | macOS 26 | Sidebar | On-device |

## What runs where

- **On the device:** voice recognition, Hera's spoken voice (Kokoro-82M via Core ML, bundled in
  the app), the website preview, and the share sheet. The access token is kept in the Keychain.
- **On the server:** the assistant (Claude), the rules every action must pass
  (`server/agent/policy.ts`), the website files, photos attached to posts, and the encrypted
  Netlify, Bluesky, X and Meta credentials. The app never holds an AI key or a provider credential.

## Publishing, per platform

| Platform | What the app does | Why |
|---|---|---|
| Website (Netlify) | Publishes after you approve | The person's own Netlify token |
| Bluesky | Publishes after you approve | Official API with revocable app passwords |
| X | Publishes after you approve | Official API v2, sign in with X (OAuth 2.0 + PKCE) |
| Facebook Page | Publishes after you approve (text, link, or a photo) | Graph API, Continue with Facebook |
| Instagram (Business or Creator, linked to a Page) | Publishes after you approve; needs a photo | Graph API content publishing, same sign-in as Facebook |
| LinkedIn | Writes the post; you share it with the Share button | Direct posting needs a registered developer app and LinkedIn's review |

X and Meta need developer apps; see [docs/SOCIAL-SETUP.md](docs/SOCIAL-SETUP.md). Adding another
platform means: a developer app, a sign-in in `server/agent/oauth.ts` and `service.ts`, an
executor case in `carryOutPost`, and the provider name in the `action_connections` check constraint.
