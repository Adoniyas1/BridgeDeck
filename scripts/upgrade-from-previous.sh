#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE="${1:-../bridgedeck-v0.2}"
node scripts/reuse-vendor.mjs "$SOURCE"
npm run vendor:verify
npm run verify:localsend-core
npm run runtime:init
if [ -d "$SOURCE/runtime" ]; then
  cp -R "$SOURCE/runtime/." runtime/
fi
printf '\nBridgeDeck v0.7 source upgrade complete. Next: npm install && npm run verify:project && npm run tauri dev\n'
