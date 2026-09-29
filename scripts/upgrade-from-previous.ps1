$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Source = if ($args.Count -gt 0) { $args[0] } else { "../bridgedeck-v0.2" }
node scripts/reuse-vendor.mjs $Source
npm run vendor:verify
npm run verify:localsend-core
npm run runtime:init
if (Test-Path (Join-Path $Source "runtime")) { Copy-Item -Recurse -Force (Join-Path $Source "runtime/*") "runtime/" }
Write-Host "`nBridgeDeck v0.7 source upgrade complete. Next: npm install; npm run verify:project; npm run tauri dev"
