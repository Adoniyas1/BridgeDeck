# BridgeDeck v0.7 verification

## Verified in the build workspace

- Static project verification: `npm run verify:project`.
- Version alignment across npm, Cargo and Tauri: `0.7.0`.
- BridgeLink commands and LAN discovery/pairing guards are present.
- BridgeLink now carries `syncthingDeviceId` and includes an authenticated metadata refresh path for v0.6 peers.
- Native Syncthing setup uses granular REST endpoints for devices and folders and does not transmit the API key through BridgeLink.
- Existing Syncthing folders are updated only by patching the device list; BridgeDeck does not replace an existing folder configuration wholesale.
- Native LocalSend direct-core integration remains present and the obsolete `localsend-cli send --to` path remains absent.
- Bootstrap archive integrity and SHA-256 are generated after packaging.

## Must be verified on the user's Mac/Windows machines

This environment does not include Rust/Cargo, so it cannot honestly claim a successful native Tauri/Rust compile. After reusing the already-verified vendored source on the Mac, run:

```bash
npm install
npm run verify:project
npm run vendor:verify
npm run verify:localsend-core
npm run tauri dev
```

Then repeat on Windows.

## Syncthing functional test

On both computers:

1. Run Syncthing and enter the local API key in BridgeDeck Settings.
2. Launch BridgeDeck v0.7 and pair/refresh the two computers.
3. Press **Setup sync** if auto-setup has not already run.
4. Confirm `BridgeDeck Shared` appears in Syncthing on both computers with the same folder ID.
5. Create a small test file on Mac and verify it appears on Windows; then create a different file on Windows and verify it appears on Mac.
6. Confirm each machine may have a different local folder path while sharing the same folder ID.

The Syncthing REST API is documented as local GUI-port HTTP with API-key authentication; BridgeDeck should normally keep that API bound to localhost.
