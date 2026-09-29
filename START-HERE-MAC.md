# BridgeDeck v0.7 — macOS package

This is the audited BridgeDeck source/bootstrap package for macOS. It is not a signed `.app` installer yet.

## Requirements

- macOS 14 or newer recommended
- Node.js and npm
- Rust/Cargo
- Xcode Command Line Tools

## Prepare and verify

```bash
npm install
node scripts/verify-project.mjs
```

The bootstrap does not include the six large upstream vendor trees. Restore them from a previously verified BridgeDeck folder or run:

```bash
npm run vendor:fetch
npm run vendor:verify
npm run verify:localsend-core
```

## Run or build

```bash
npm run tauri dev
npm run tauri build
```

Before normal use, review `AUDIT_REPORT.md`. BridgeLink pairing is currently intended only for a trusted LAN.
