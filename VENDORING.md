# BridgeDeck vendoring — v0.7

`vendor-lock.json` remains the source of truth for all six upstream projects.

Reuse an existing verified BridgeDeck tree:

```bash
node scripts/reuse-vendor.mjs ../bridgedeck-v0.2
npm run vendor:verify
npm run verify:localsend-core
```

Or fetch from upstream:

```bash
npm run vendor:fetch
npm run vendor:verify
npm run verify:localsend-core
```

## Important v0.5+ change

BridgeDeck no longer requires a built `localsend-cli` runtime for its normal Files workflow. `src-tauri/Cargo.toml` links directly to:

```text
vendor/localsend/packages/core
```

Therefore the pinned LocalSend source must be present before `npm run tauri dev` or `npm run tauri build`.

Standalone runtimes under `runtime/` are still used for components such as Syncthing (built from `vendor/syncthing` by `scripts/build-syncthing.mjs`).
