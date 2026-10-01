#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npm run vendor:verify
npm run verify:localsend-core
npm install
npm run tauri build
# Sign with the free local certificate when it exists (npm run mac:signing), so permissions stick.
APP="src-tauri/target/release/bundle/macos/BridgeDeck.app"
if [ -d "$APP" ] && security find-identity -v -p codesigning 2>/dev/null | grep -q '"BridgeDeck Local Signing"'; then
  codesign --force --deep -s "BridgeDeck Local Signing" "$APP"
fi
