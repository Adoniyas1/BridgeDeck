#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npm run vendor:verify
npm run verify:localsend-core
npm install
npm run tauri build
