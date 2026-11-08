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
(on the CPU there), and can be turned off in Settings → Voice. If her own voice can't load on a
device she retries on the CPU, then falls back to the system's best voice and says so on screen.

**Talk to Hera.** Say "Hey Siri, talk to Hera" (or "Hey Siri, Hey Hera", "Start Hera", "Create
with Hera"), or run the "Talk to Hera" shortcut. The app opens on Create; Hera asks whether you'd
like a website or posts, listens, asks what it's about, and starts on it. The mic stops on its own
when you stop talking. Siri can take a few minutes after installing a new build to learn the
phrases; Product → App Shortcuts Preview in Xcode shows how they match.

**Website and posts are separate.** The Create tab's Website / Posts switch picks one per run;
the server only gives the assistant that mode's tools (`AGENT_MODES` in `server/agent/loop.ts`).

## Tests

```bash
npm run check             # server: typecheck + tests
npm run app:build         # app: builds for iOS Simulator and macOS
```

In Xcode, ⌘U runs the app's Swift Testing suite (`app/CyberCompanionTests`).

## TestFlight

```bash
npm run app:archive       # archives iPhone/iPad and Mac into Xcode's Organizer
```

Then in Xcode: **Window → Organizer → Archives**, select each new "Hera" archive, **Distribute
App → App Store Connect → Distribute**. After processing (about 10–30 minutes) the build appears
under the app's **TestFlight** tab in App Store Connect.

- The Mac archive is Apple silicon only and must come from the script: Product → Archive for
  "Any Mac" fails, because the voice package can't compile for Intel and Xcode doesn't pass the
  architecture setting on to packages. The iPhone archive can also be made with Product → Archive.
- Raise **Build** (Target → General → Identity) before every upload; App Store Connect refuses a
  build number it has already seen. Raise **Version** for each release.
- Release builds hide Settings → Advanced (server addresses, developer token); they connect through
  `AppConfig.swift` and Sign in with Apple only.
