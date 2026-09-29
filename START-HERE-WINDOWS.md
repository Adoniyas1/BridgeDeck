# BridgeDeck v0.7 — Windows package

This is the audited BridgeDeck source/bootstrap package for this Windows PC. It is not an `.exe` installer yet.

## Requirements

- Node.js with npm or pnpm
- Rust/Cargo using the MSVC toolchain
- Microsoft C++ Build Tools and WebView2

## Prepare and verify

```powershell
npm install
node .\scripts\verify-project.mjs
```

The bootstrap does not include the six large upstream vendor trees. Restore them from a previously verified BridgeDeck folder or run:

```powershell
npm run vendor:fetch
npm run vendor:verify
npm run verify:localsend-core
```

## Run or build

```powershell
npm run tauri dev
npm run tauri build
```

Before normal use, review `AUDIT_REPORT.md`. BridgeLink pairing is currently intended only for a trusted LAN.
