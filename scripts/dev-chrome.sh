#!/usr/bin/env bash
# Local interactive test environment: builds the Chrome bundle pointed at the mock backend,
# starts the mock, and launches a disposable Chrome profile with the extension loaded
# unpacked. This is the real chrome-extension:// origin — unlike opening the HTML files
# directly (file://) or over a plain static server, module scripts, chrome.storage,
# chrome.commands, chrome.action badges, and the side panel all actually work here.
#
# Usage: npm run dev
# Env:   CHROME_BIN=/path/to/chrome npm run dev   (override browser binary)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${CHROME_BIN:-}" ]; then
  CHROME="$CHROME_BIN"
elif [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v google-chrome >/dev/null 2>&1; then
  CHROME="google-chrome"
elif command -v chromium >/dev/null 2>&1; then
  CHROME="chromium"
else
  echo "Could not find Chrome. Set CHROME_BIN=/path/to/chrome and re-run." >&2
  exit 1
fi

echo "==> Building dist/chrome pointed at the local mock backend"
npm run build:mock

echo "==> Starting the mock backend on :4000"
npm run mock &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true; rm -rf "$PROFILE_DIR"' EXIT
sleep 1

PROFILE_DIR="$(mktemp -d -t cyber-companion-profile)"

cat <<EOF

==> Launching Chrome with the extension loaded unpacked from dist/chrome
    (disposable profile: $PROFILE_DIR)

    - Pin the extension (puzzle-piece icon) and click it to open the side panel.
    - Alt+Shift+C opens the panel, Alt+Shift+M toggles mute — change them at
      chrome://extensions/shortcuts if they clash with something else.
    - The toolbar icon badge shows the quiet-state color and held-alert count.
    - The gear in the panel footer opens the new options page.
    - chrome://extensions -> this card -> "service worker" opens its console; watch
      it and the terminal here for the mock backend's request log.
    - Closing this Chrome window stops the mock backend and deletes the profile.

EOF

"$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$(pwd)/dist/chrome" \
  --no-first-run --no-default-browser-check
