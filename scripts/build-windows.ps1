$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
npm install
node scripts/vendor.mjs fetch --only localsend,syncthing
npm run vendor:verify
npm run verify:localsend-core
npm run runtime:build
npm run tauri build
