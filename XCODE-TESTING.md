# Running the app in Xcode

The app is one SwiftUI project for iPhone, iPad and Mac: `app/CyberCompanion.xcodeproj`.

## What you need

- Xcode 26 or later. The app targets iOS 26 / macOS 26, the first releases with on-device
  `SpeechAnalyzer` and SwiftUI's `WebView`.
- Node 20+ for the server (or the mock below).
- A free Apple ID runs it on the Mac and in the Simulator. A device build or App Store
  submission needs the Apple Developer Program, and a team set under Signing & Capabilities.

## First run, against the mock server (about two minutes)

```bash
npm install
npm run mock:app          # http://localhost:4480, any token works
open app/CyberCompanion.xcodeproj
```

Pick a run destination (My Mac or an iPhone simulator) and press ⌘R. In the app, open
**Settings**, enter `http://localhost:4480` and any token, and tap **Save and connect**.
Plain `http` is accepted only for `localhost`; real servers must use `https`.

Debug builds can skip that step: in the scheme's Run → Arguments, set the environment variables
`CC_SERVER_URL=http://localhost:4480` and `CC_ACCESS_TOKEN=dev`.

## Against the real server

`npm start` runs the server (see `.env.example` for its settings, including `ANTHROPIC_API_KEY`
and the database). Point the app at its https address and use your access token
(`TEST_ACCESS_TOKEN` on staging).

For a database created before Bluesky publishing existed, run
`db/migrations/001_bluesky_provider.sql` once.

## Voice

Tap the orb on the Create tab to speak. Speech is recognized on the device by Apple's
`SpeechAnalyzer`; the audio never leaves it, and only the finished text is sent when you tap
Create. The first use downloads the speech model for your language (shared with other apps,
kept up to date by the system). Devices without the newer model fall back to
`DictationTranscriber`.

**The Simulator can't test voice input**: Apple's speech models don't run there. Use a Mac or a
physical iPhone.

Hera's replies are spoken by Kokoro-82M (voice `af_heart`), bundled in
`app/CyberCompanion/Voice/HeraVoice.bundle` and run with Core ML. It works in the Simulator too
(on the CPU there), and can be turned off in Settings → Voice.

## Tests

```bash
npm run check             # server: typecheck + tests
npm run app:build         # app: builds for iOS Simulator and macOS
```

In Xcode, ⌘U runs the app's Swift Testing suite (`app/CyberCompanionTests`).
