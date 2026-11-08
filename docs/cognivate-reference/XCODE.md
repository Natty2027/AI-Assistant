# Cognivate — Xcode deployment guide

You ejected from the Expo managed workflow to the bare workflow. This
guide walks the full path from a fresh `pnpm install` to a build sitting
in App Store Connect, using Xcode directly.

If you're reading this and you don't remember choosing this path, see
DEPLOY.md instead — that doc covers the managed-workflow path (Replit
Expo Launch).

---

## What you'll need

**Hardware / software:**
- A Mac running macOS 15 (Sequoia) or newer
- **Xcode 26** installed from the Mac App Store. Required for the iOS 26
  SDK, which Apple requires for all App Store submissions as of April 28,
  2026. Open Xcode → Xcode menu → About Xcode. If you're on Xcode 25 or
  older, update before doing anything else; the upload will be rejected
  otherwise.
- Node 24 and pnpm 9+ (`brew install node pnpm`)
- CocoaPods (`sudo gem install cocoapods` if you don't have it; ships
  with macOS Sequoia by default)

**Apple Developer:**
- An active Apple Developer Program membership ($99/year)
- Your Apple ID logged into Xcode (Xcode → Settings → Accounts → +)
- Your developer team selected — `com.cognivate.mobile` will be your
  app's bundle identifier, so make sure no one else in your developer
  team has registered that identifier already

---

## Step 1 — Install dependencies

From the repo root (the directory containing `pnpm-workspace.yaml`):

```bash
pnpm install
```

This installs every workspace package. First run takes a few minutes.

---

## Step 2 — Generate the iOS project

This is the prebuild step that turns the managed-workflow project into a
bare-workflow project with a real Xcode project file.

```bash
cd artifacts/cognivate-mobile
npx expo prebuild --platform ios --clean
```

What this does:
- Reads `app.json`
- Generates `artifacts/cognivate-mobile/ios/` containing:
  - `Cognivate.xcworkspace` — what you'll open in Xcode
  - `Cognivate.xcodeproj`
  - `Podfile` (CocoaPods dependencies)
  - `Cognivate/Info.plist` (your permission strings, populated from
    `app.json`'s `ios.infoPlist`)
  - `Cognivate/AppDelegate.swift` and other native scaffolding
- Symlinks all the `expo-*` packages from `node_modules` into the iOS
  build

`--clean` deletes any prior `ios/` directory first. Use it whenever you
re-prebuild after changing `app.json`.

If prebuild fails with "cannot find expo-build-properties," run
`pnpm install` again — it might not have linked yet.

---

## Step 3 — Install CocoaPods dependencies

```bash
cd ios
pod install
cd ..
```

This resolves and downloads the native iOS dependencies referenced by
each Expo package's podspec. First run can take 5-10 minutes; subsequent
runs are seconds.

If you get "ruby version" errors, you may need to install a newer Ruby
via `brew install ruby` and follow the path-update instructions brew
prints. macOS's system Ruby is often too old for current CocoaPods.

After this completes, you'll see `Cognivate.xcworkspace` next to
`Cognivate.xcodeproj`. Always open the **`.xcworkspace`** in Xcode,
never the `.xcodeproj` directly — the workspace includes the Pods
project that the workspace needs.

---

## Step 4 — Open in Xcode

```bash
open ios/Cognivate.xcworkspace
```

Xcode launches and loads the project. First load takes a minute or two
as Xcode indexes Swift Package Manager dependencies.

---

## Step 5 — Configure code signing

In Xcode's left sidebar, click the blue `Cognivate` project icon at the
top. In the editor area:

1. Select the `Cognivate` target (under TARGETS)
2. Click the `Signing & Capabilities` tab
3. Check `Automatically manage signing`
4. Select your Apple Developer team from the `Team` dropdown
5. Verify `Bundle Identifier` is `com.cognivate.mobile`

Xcode will provision a development certificate and provisioning profile
for you. If it complains about the bundle identifier being taken, you
need to either pick a different identifier (but that requires updating
`app.json` and re-prebuild) or remove the conflicting app from your
developer account.

For production / App Store distribution, the Signing tab will also show
a "Distribution" section — Xcode handles this automatically when you
later select Any iOS Device + Archive.

---

## Step 6 — Set environment variables

The mobile app reads `EXPO_PUBLIC_DOMAIN` at build time to know which
API server to talk to. For Xcode-driven builds, set it in your shell
environment BEFORE Xcode launches the Metro bundler.

**Quick test on simulator:**

```bash
# Back in artifacts/cognivate-mobile/
export EXPO_PUBLIC_DOMAIN=your-api-server-domain.com
npx expo start
```

Then in Xcode, press Run (▶ at the top). Xcode will start the simulator
and connect to the Metro bundler you started above.

**For Release builds**, you'll need to set this in Xcode's scheme:
1. Product menu → Scheme → Edit Scheme
2. Pick `Run` → `Arguments` tab
3. Under `Environment Variables`, add `EXPO_PUBLIC_DOMAIN` with your
   production value
4. Repeat for `Archive`

Without `EXPO_PUBLIC_DOMAIN`, the app shows a "Configuration Error"
screen at launch.

---

## Step 7 — Run on the simulator

In Xcode, the toolbar at the top has a scheme selector and a device
selector. Pick:
- Scheme: `Cognivate`
- Device: any iPhone simulator (iPhone 16 Pro is a good default)

Press the ▶ Play button. First build takes 5-15 minutes (Xcode compiles
every CocoaPod from source). Subsequent builds are seconds.

When the simulator opens, the app should launch. If you see
"Configuration Error," your `EXPO_PUBLIC_DOMAIN` isn't set — go back
to Step 6.

---

## Step 8 — Run on a real device

1. Plug your iPhone into your Mac with a USB cable
2. On the iPhone: Settings → Privacy & Security → Developer Mode → On
   (requires a restart on the iPhone)
3. In Xcode's device selector at the top, pick your iPhone
4. Press ▶ Play

Xcode installs the app on your device. On first launch you may need to
trust the developer profile: iPhone → Settings → General → VPN & Device
Management → tap your developer profile → Trust.

---

## Step 9 — Archive for App Store

When you're ready to submit:

1. In Xcode's device selector, pick **`Any iOS Device (arm64)`**. Do
   NOT use a simulator — archives must target real device architecture.
2. Product menu → Archive
3. Wait. This takes 10-20 minutes. Xcode compiles everything in Release
   mode and packages it.
4. When done, the Organizer window opens automatically showing your
   archive.
5. Click `Distribute App`
6. Choose `App Store Connect`
7. Choose `Upload`
8. Walk through the wizard. Defaults are fine for most settings:
   - Strip Swift symbols: Yes
   - Upload symbols for crashes: Yes
   - Manage version and build number: Yes (Xcode auto-increments)
9. Sign with your Distribution certificate (Xcode handles this)
10. Click `Upload`. The IPA uploads to App Store Connect.

If upload succeeds, you'll see a green checkmark. The build then needs
to be processed by Apple (usually 10-30 minutes, sometimes hours)
before it appears in App Store Connect under TestFlight.

---

## Step 10 — App Store Connect setup

This part is the same regardless of how you built the IPA. See
SUBMISSION.md for the full checklist. Quick summary:

1. Log into App Store Connect (appstoreconnect.apple.com)
2. Create the app entry if you haven't: name "Cognivate," bundle
   identifier `com.cognivate.mobile`, primary language English
3. Once your build appears under TestFlight, install it on a real
   iPhone via the TestFlight app and run the smoke test from
   SUBMISSION.md section 7
4. Fill out App Privacy questionnaire — see SUBMISSION.md section 4
5. Add a Privacy Policy URL (you must host this yourself)
6. Add screenshots (6.7" or 6.9", no emojis)
7. Add review notes including demo account credentials and AI consent
   flow explanation (template in SUBMISSION.md)
8. Submit for review

Apple review takes 24 hours to a week typically. Watch your email for
status updates.

---

## When you change `app.json` or add an Expo package

Because you're in bare workflow now, native config changes don't
auto-apply. Workflow:

```bash
# After changing app.json or adding/removing an expo-* package:
cd artifacts/cognivate-mobile
npx expo prebuild --platform ios --clean
cd ios && pod install && cd ..
# Then reopen Cognivate.xcworkspace in Xcode (it'll detect the change)
```

`--clean` is destructive: it deletes anything in `ios/` not generated
from `app.json`. If you made manual native edits in Xcode (you usually
won't need to), those are lost on `--clean`. You'd track them in
`app.json` config plugins instead.

---

## When you bump the version

Two numbers matter:

- `version` in `app.json` (e.g., "1.0.0" → "1.0.1") — the user-visible
  version. Bump for any user-meaningful release.
- `ios.buildNumber` in `app.json` (e.g., "1" → "2") — internal build
  number. **Apple rejects duplicate build numbers**, so bump this for
  every TestFlight or App Store upload, even if `version` didn't
  change.

After bumping, re-prebuild + `pod install` so the values land in
`Info.plist`.

---

## Troubleshooting

**"Sandbox: bash deny" during build.** Xcode 15+ tightened sandboxing
on shell scripts in build phases. If a Pod build phase fails with this,
the fix is in the affected pod's xcconfig: add
`ENABLE_USER_SCRIPT_SANDBOXING = NO`. Xcode 16+ usually handles this
automatically.

**"Multiple commands produce" linking errors.** Almost always means
`pod install` is stale. Run it again.

**App launches but immediately shows "Configuration Error."**
`EXPO_PUBLIC_DOMAIN` not set in the scheme's environment variables
(Step 6).

**Build succeeds but app crashes on launch with "no bundle URL
present."** Metro bundler isn't running. From
`artifacts/cognivate-mobile/`, run `npx expo start` in another
terminal before pressing Run.

**Archive succeeds but upload fails with "Invalid Swift Support."** You
have a stale archive — delete it and re-archive. Common after switching
between Debug and Release configs.

**"This bundle is invalid — iOS apps must include an
ITSAppUsesNonExemptEncryption value in Info.plist."** Your prebuild
didn't pick up the `ITSAppUsesNonExemptEncryption: false` from
`app.json`. Verify it's there in the generated `ios/Cognivate/
Info.plist`, then re-prebuild.

**Code signing errors at Archive time.** Xcode → Settings → Accounts
→ Manage Certificates → make sure you have a Distribution certificate.
If not, click + → Apple Distribution. Then re-Archive.

**Weird build errors after re-running prebuild or adding a package.**
Xcode caches aggressively. The full cache-bust sequence is:
```bash
cd artifacts/cognivate-mobile/ios
rm -rf Pods Podfile.lock
cd ..
rm -rf ios   # only if you want a fully fresh prebuild output
npx expo prebuild --platform ios --clean
cd ios && pod install && cd ..
```
Plus in Xcode: Product → Clean Build Folder (⇧⌘K), then quit Xcode
and `rm -rf ~/Library/Developer/Xcode/DerivedData/Cognivate-*`.
Reopen the workspace. About 90% of "this used to work" Xcode errors
go away after this sequence.

**Metro can't find `@workspace/api-client-react` or other workspace
packages.** The pnpm symlink + Metro resolver dance is fragile. The
fix is already baked into `metro.config.js` (watchFolders pointing to
the repo root, `unstable_enableSymlinks: true`). If you somehow get
this error, verify `metro.config.js` matches the version in the zip.

**"No Podfile.lock generated for X" or pod install skips packages.**
Almost always means `node-linker=hoisted` got overridden somewhere or
pnpm install hasn't been re-run after a package was added. Verify
`artifacts/cognivate-mobile/.npmrc` still has `node-linker=hoisted`,
then `pnpm install` from the repo root, then re-run pod install.

---

## What you've given up

For the record, since you came from the managed workflow:

1. **Replit Expo Launch no longer fits.** It's designed for managed
   projects. You can keep the Replit project around for the API server,
   but mobile builds happen on your Mac now.
2. **Future Expo SDK upgrades are manual.** When SDK 55 ships, you'll
   re-run prebuild (which regenerates native config) and reconcile any
   merge conflicts. Managed workflow handles this for you.
3. **You own all native config.** Permission strings, URL schemes, app
   capabilities, code signing — yours to maintain. Most lives in
   `app.json` and propagates via prebuild, but some Xcode-only settings
   (like Capabilities you toggle in the Signing tab) live in the
   `project.pbxproj` and aren't tracked by `app.json`.

---

## What you've gained

1. Press Run in Xcode and the app builds locally
2. Full Xcode debugger, Instruments, view hierarchy inspector
3. Can add native Swift/Obj-C code, share extensions, widgets, custom
   modules
4. Direct control of code signing
5. Direct App Store upload (no third-party build service)
