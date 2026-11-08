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
  (`server/agent/policy.ts`), the website files, and the encrypted Netlify and Bluesky
  credentials. The app never holds an AI key or a provider credential.

## Publishing, per platform

| Platform | What the app does | Why |
|---|---|---|
| Website (Netlify) | Publishes after you approve | The person's own Netlify token |
| Bluesky | Publishes after you approve | Official API with revocable app passwords |
| Instagram, X, LinkedIn, Facebook | Writes the post; you share it with the Share button | Direct posting needs a registered developer app and each platform's review |

Adding direct posting for one of the others means: registering a developer app, an OAuth
connection like `connectBluesky` in `server/agent/service.ts`, an executor in `carryOutPost`,
and the provider name in the `action_connections` check constraint.
