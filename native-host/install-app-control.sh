#!/usr/bin/env bash
# Installs, or removes, the app-control helper for the browsers on this Mac.
#
#   native-host/install-app-control.sh <extension-id>     install for that extension only
#   native-host/install-app-control.sh --uninstall        remove it from every browser
#
# Why the extension id matters: the registration lists the ONE extension allowed to talk to the
# helper. A web page, or any other extension, cannot reach it. Use the id shown on
# chrome://extensions for this extension (32 letters, a-p).
#
# NMH_DIR=<folder> installs into just that folder instead of the real browsers (used by tests).
set -euo pipefail

HOST="com.acc.appcontrol"
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/app-control.py"
FIREFOX_ID="ambient-companion@yourorg.example"   # keep in step with GECKO_ID in src/platform/manifest.ts
SUPPORT="$HOME/Library/Application Support"

# The helper is COPIED here and the copy is what gets registered. Registering the file inside the
# project folder fails on macOS: the browser launches the helper, and macOS does not let a
# browser-launched program read ~/Documents, ~/Desktop or ~/Downloads ("Operation not permitted"),
# which is exactly where a cloned project tends to live. It is also safer for the registered file
# to be a stable copy that a later change to the source tree cannot alter underneath the browser.
# Re-run this script after updating the project to refresh the copy.
HELPER_DIR="${HELPER_DIR:-$SUPPORT/AmbientCyberCompanion}"
SCRIPT="$HELPER_DIR/app-control.py"

[ "$(uname)" = "Darwin" ] || { echo "App control only supports macOS for now." >&2; exit 1; }

# Browser support folder -> manifest style. Chromium-family browsers list allowed_origins;
# Firefox lists allowed_extensions.
chromium_dirs=(
  "$SUPPORT/Google/Chrome"
  "$SUPPORT/Microsoft Edge"
  "$SUPPORT/Chromium"
  "$SUPPORT/BraveSoftware/Brave-Browser"
)
firefox_dir="$SUPPORT/Mozilla"

remove_all() {
  local removed=0
  for base in "${chromium_dirs[@]}" "$firefox_dir"; do
    f="$base/NativeMessagingHosts/$HOST.json"
    if [ -f "$f" ]; then rm -f "$f"; echo "removed $f"; removed=1; fi
  done
  [ "$removed" = 1 ] || echo "nothing to remove"
}

remove_helper() {
  if [ -f "$SCRIPT" ]; then rm -f "$SCRIPT"; echo "removed $SCRIPT"; fi
  rmdir "$HELPER_DIR" 2>/dev/null || true   # only if now empty
}

if [ "${1:-}" = "--uninstall" ]; then
  if [ -n "${NMH_DIR:-}" ]; then rm -f "$NMH_DIR/$HOST.json"; echo "removed from $NMH_DIR"; else remove_all; fi
  remove_helper
  exit 0
fi

ID="${1:-}"
if ! [[ "$ID" =~ ^[a-p]{32}$ ]]; then
  echo "Give the extension id (32 letters a-p), shown on chrome://extensions." >&2
  echo "usage: $0 <extension-id>   |   $0 --uninstall" >&2
  exit 2
fi
[ -f "$SOURCE" ] || { echo "missing $SOURCE" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# Install the copy: owned by you, not writable by anyone else, and never a symlink into the project.
mkdir -p "$HELPER_DIR"
chmod 700 "$HELPER_DIR"
rm -f "$SCRIPT"
cp "$SOURCE" "$SCRIPT"
chmod 755 "$SCRIPT"
echo "installed helper at $SCRIPT"

write_manifest() {   # $1 = destination folder, $2 = "chromium" | "firefox"
  mkdir -p "$1"
  local who
  if [ "$2" = firefox ]; then who="\"allowed_extensions\": [\"$FIREFOX_ID\"]"; else who="\"allowed_origins\": [\"chrome-extension://$ID/\"]"; fi
  cat > "$1/$HOST.json" <<EOF
{
  "name": "$HOST",
  "description": "Lets the Ambient Cyber Companion open and close apps you have allowed",
  "path": "$SCRIPT",
  "type": "stdio",
  $who
}
EOF
  echo "installed $1/$HOST.json"
}

if [ -n "${NMH_DIR:-}" ]; then
  write_manifest "$NMH_DIR" chromium
  exit 0
fi

installed=0
for base in "${chromium_dirs[@]}"; do
  [ -d "$base" ] && { write_manifest "$base/NativeMessagingHosts" chromium; installed=1; }
done
[ -d "$firefox_dir" ] && { write_manifest "$firefox_dir/NativeMessagingHosts" firefox; installed=1; }
[ "$installed" = 1 ] || { echo "No supported browser found. Open the browser once, then run this again." >&2; exit 1; }

echo
echo "Done. Restart the browser, then turn on 'Open and close apps' in the extension's Settings."
