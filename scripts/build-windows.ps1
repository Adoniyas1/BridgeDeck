$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
npm run vendor:verify
npm run verify:localsend-core
npm install
npm run tauri build
