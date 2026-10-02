#!/bin/bash
# Rebuilds and reinstalls BridgeDeck on macOS. Started detached by BridgeDeck itself (src-tauri/src/upgrade.rs)
# after the user approved the upgrade; BridgeDeck runs a copy of this script, so it may rewrite the original.
#   self-update.sh <git|source> <bundle-or-empty> <status.json> <source-dir> <installed .app>
# Progress goes to the status JSON (read by /upgrade/status) and details to "<status>.log".
set -uo pipefail
MODE="$1"; BUNDLE="$2"; STATUS="$3"; SRC="$4"; APP_BUNDLE="$5"
LOG="$STATUS.log"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
echo "=== BridgeDeck self-update $(date) mode=$MODE src=$SRC" > "$LOG"

REQUESTED_BY=$(/usr/bin/sed -n 's/.*"requestedBy": *"\([^"]*\)".*/\1/p' "$STATUS" 2>/dev/null | head -1)
FROM_VERSION=$(/usr/bin/sed -n 's/.*"fromVersion": *"\([^"]*\)".*/\1/p' "$STATUS" 2>/dev/null | head -1)
set_status() { # state stage message
  local message=${3//\"/\'}; message=${message//\\/\/}
  printf '{"state":"%s","stage":"%s","message":"%s","mode":"%s","requestedBy":"%s","fromVersion":"%s","updatedAt":%s}\n' \
    "$1" "$2" "$message" "$MODE" "$REQUESTED_BY" "$FROM_VERSION" "$(($(date +%s) * 1000))" > "$STATUS"
  echo "[$2] $3" >> "$LOG"
}
fail() { set_status failed "$1" "$2 (log: $LOG)"; exit 1; }
run() { # stage label command...
  local stage=$1 label=$2; shift 2
  set_status running "$stage" "$label"
  "$@" >> "$LOG" 2>&1 || fail "$stage" "$label failed"
}

cd "$SRC" || fail setup "Source folder $SRC is missing"
if [ "$MODE" = git ]; then
  run pull "Pulling the latest version from GitHub" git -C "$SRC" pull --ff-only
else
  [ -f "$BUNDLE" ] || fail unpack "Source bundle is missing"
  run unpack "Unpacking the source sent by the other computer" tar -xzf "$BUNDLE" -C "$SRC"
fi

set_status running deps "Installing dependencies"
npm ci >> "$LOG" 2>&1 || run deps "Installing dependencies" npm install
[ -d vendor/localsend/packages/core ] || run vendor "Fetching LocalSend source" node scripts/vendor.mjs fetch --only localsend
run verify "Checking the project" npm run verify:project
# Only the .app: a disk image isn't needed here, and making one drives Finder, which can hang
# when no one is there to allow it.
run build "Building BridgeDeck (several minutes)" npm run tauri build -- --bundles app

NEW_APP="$SRC/src-tauri/target/release/bundle/macos/BridgeDeck.app"
[ -d "$NEW_APP" ] || fail install "The build produced no app bundle"
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
set_status running install "Installing v$VERSION"
osascript -e 'tell application id "dev.bridgedeck.app" to quit' >/dev/null 2>&1
sleep 3
pkill -x bridgedeck >/dev/null 2>&1
rm -rf "$APP_BUNDLE.previous"
mv "$APP_BUNDLE" "$APP_BUNDLE.previous" || fail install "Could not move the old app aside"
if ! ditto "$NEW_APP" "$APP_BUNDLE"; then
  rm -rf "$APP_BUNDLE"; mv "$APP_BUNDLE.previous" "$APP_BUNDLE"
  fail install "Could not copy the new app; the previous version was restored"
fi
# The free local certificate (npm run mac:signing) keeps macOS permissions across updates; without it
# the build is signed ad hoc and macOS asks for them again.
IDENTITY="BridgeDeck Local Signing"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  codesign --force --deep -s "$IDENTITY" "$APP_BUNDLE" >> "$LOG" 2>&1 || codesign --force --deep -s - "$APP_BUNDLE" >> "$LOG" 2>&1
else
  codesign --force --deep -s - "$APP_BUNDLE" >> "$LOG" 2>&1
fi
xattr -dr com.apple.quarantine "$APP_BUNDLE" >> "$LOG" 2>&1
rm -rf "$APP_BUNDLE.previous"
set_status succeeded done "Updated to v$VERSION"
open "$APP_BUNDLE"
