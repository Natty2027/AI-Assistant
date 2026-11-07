# App control helper (optional)

Lets you type **"open Zoom"** or **"close Slack"** in the panel. macOS only for now.

The helper is a small separate program, kept apart from the Focus probe on purpose: this one can
start and quit programs, so you install it deliberately and can remove it in one command.

## Install

1. Open `chrome://extensions`, find the extension, copy its **ID** (32 letters).
2. In a terminal:

   ```
   native-host/install-app-control.sh <that-id>
   ```

3. Restart the browser.
4. In the extension's **Settings → Open and close apps**, turn it on and tick the apps you want.

The installer **copies** the helper to `~/Library/Application Support/AmbientCyberCompanion/` and
registers that copy. It has to: macOS won't let a browser-launched program read files in
`~/Documents`, `~/Desktop` or `~/Downloads`, so a helper registered from a project folder in one of
those fails with "Native host has exited". Run the installer again after updating the project to
refresh the copy.

## Remove

```
native-host/install-app-control.sh --uninstall
```

## What it can and cannot do

- It acts **only when you ask**, from the panel. Web pages, calendar entries, captured images and the
  AI model have no way to trigger it.
- It can only touch apps **you ticked**. Turn the switch off and nothing can be opened or closed.
- **Opening** happens immediately. **Closing** always asks you first, because an app may hold unsaved work.
- Closing is a polite request (the app's own Quit), so an app can still ask you to save. **There is no
  force-quit.** If an app is waiting on a save dialog, the panel says so.
- Your **browser, Finder and core system apps** can be opened but never closed from here.
- The helper only accepts an app it found by scanning your installed apps itself; it never runs a
  command it is handed, and it limits how fast it can be asked.
- Your list of installed apps stays on this computer. It is not sent to any server.

## First time you close an app

macOS asks whether the browser may control that app ("*wants to control …*"). That prompt is macOS's
own safeguard, and the panel will say so if closing is waiting on it. Allow it once per app. Opening
apps does not need any permission.

## If it doesn't work

- "**The app helper isn't installed**": run the install step again with the right extension ID, then
  restart the browser. The ID changes if you load the extension from a different folder.
- Nothing listed: the helper only lists apps in `/Applications`, `/System/Applications`, their
  `Utilities` folders, and `~/Applications`.
