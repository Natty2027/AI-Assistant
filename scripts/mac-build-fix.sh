#!/bin/zsh
# Makes the Share extension (HeraShare) iPhone and iPad only, so the Mac app can build.
# This is the same change as setting HeraShare's filter to "iOS" in Xcode under
# CyberCompanion target > General > Frameworks, Libraries, and Embedded Content.
# Xcode must be closed: it rewrites the project file and would undo the change.
set -euo pipefail
cd "$(dirname "$0")/../app"
P=CyberCompanion.xcodeproj/project.pbxproj

if ps -Ao comm | grep -q "Xcode.app/Contents/MacOS/Xcode"; then
  echo "Quit Xcode first (Xcode > Quit Xcode), then run this again."; exit 1
fi
if grep -q "platformFilter = ios" "$P"; then
  echo "Already done: HeraShare is iOS only."; exit 0
fi
cp "$P" "$P.backup"
# The embed step: only copy HeraShare.appex into the iPhone and iPad app.
sed -i '' 's|\(F1AA926530ACF4410004C05F /\* HeraShare.appex in Embed Foundation Extensions \*/ = {isa = PBXBuildFile; \)|\1platformFilter = ios; |' "$P"
# The dependency: only build HeraShare for iPhone and iPad.
sed -i '' '/F1AA926430ACF4410004C05F \/\* PBXTargetDependency \*\/ = {/,/};/ s|\(isa = PBXTargetDependency;\)|\1\
			platformFilter = ios;|' "$P"
if [ "$(grep -c 'platformFilter = ios' "$P")" != 2 ]; then
  mv "$P.backup" "$P"; echo "Couldn't make the change; the project is unchanged."; exit 1
fi
plutil -lint "$P" >/dev/null || { mv "$P.backup" "$P"; echo "The project file didn't check out; restored it."; exit 1; }
rm "$P.backup"
echo "Done. HeraShare is now iPhone and iPad only. Open Xcode again; the Mac app will build."
