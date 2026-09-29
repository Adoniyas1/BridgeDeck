# Keeping BridgeDeck in sync between the Mac and Windows

The BridgeDeck project folder is shared between the two computers by Syncthing (folder ID
`bridgedeck-source`). Source code syncs; each computer keeps its own `vendor/`, `node_modules/`,
`src-tauri/target/` and other build output, and builds its own native app.

| Computer | Project folder |
|---|---|
| Windows | `C:\Users\adoni\Documents\Codex\BridgeDeck-v0.7-Windows` |
| Mac | `~/Documents/Playground/BridgeDeck-v0.7-macOS` |

## Setting up a computer

1. Put `.stignore` (from the other computer's project folder, byte-for-byte) in the project root
   **before** accepting the folder. Syncthing does not sync `.stignore`; without it, `vendor/`,
   `node_modules/` and build output would be exchanged.
2. Accept folder `bridgedeck-source` in Syncthing with the project folder as its path.

## When edits arrive

BridgeDeck compares source file times with the time of the running build. When the other computer's
changes arrive, a "source changed since this build" notice appears. Rebuild and reinstall:

- Windows: `tauri build` (see `START-HERE-WINDOWS.md`), then run the NSIS installer.
- Mac: `npm run tauri build`, then replace `/Applications/BridgeDeck.app`.

## Working rules for Claude and Codex

- Announce on the AI relay (`#planning` channel) which files you are about to edit, and wait for the
  other side to acknowledge before editing a file they touched recently. Concurrent edits to the
  same file produce `*.sync-conflict-*` copies that someone has to merge by hand.
- Build and install only on your own computer.
- Don't delete `*.sync-conflict-*` files without comparing them first; say on the relay what was merged.
