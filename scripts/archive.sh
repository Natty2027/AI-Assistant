#!/bin/bash
# Archives Hera for TestFlight and the App Store. The archives go into Xcode's Archives folder,
# so they appear in Window → Organizer, ready for Distribute App → App Store Connect.
#
#   scripts/archive.sh          iPhone/iPad and Mac
#   scripts/archive.sh ios      iPhone/iPad only (Product → Archive in Xcode also works for this)
#   scripts/archive.sh mac      Mac only
#
# Why the Mac needs this script: its archive is Apple silicon only (ARCHS=arm64). The voice package
# (KokoroCoreML) uses Float16, which doesn't exist on Intel Macs, and Xcode doesn't pass a target's
# architecture settings on to Swift packages, so Product → Archive for "Any Mac" fails to compile.
set -euo pipefail
cd "$(dirname "$0")/../app"

which="${1:-all}"
case "$which" in all|ios|mac) ;; *) echo "usage: scripts/archive.sh [ios|mac]" >&2; exit 2 ;; esac

dir="$HOME/Library/Developer/Xcode/Archives/$(date +%Y-%m-%d)"
stamp="$(date +%H.%M.%S)"
mkdir -p "$dir"

archive() { # name destination [extra xcodebuild settings...]
  local name="$1" destination="$2"; shift 2
  local path="$dir/Hera $name $stamp.xcarchive"
  xcodebuild archive -quiet \
    -project CyberCompanion.xcodeproj -scheme CyberCompanion -configuration Release \
    -destination "$destination" -archivePath "$path" -allowProvisioningUpdates "$@"
  echo "Archived: $path"
}

if [ "$which" != mac ]; then archive iOS "generic/platform=iOS"; fi
if [ "$which" != ios ]; then archive Mac "generic/platform=macOS" ARCHS=arm64; fi
echo "Open Xcode → Window → Organizer to upload."
