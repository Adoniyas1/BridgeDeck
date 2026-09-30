# BridgeDeck runtime directory

`vendor/` contains editable upstream source. `runtime/` contains standalone executables BridgeDeck may bundle for components that still run as separate processes.

Run:

```bash
npm run runtime:init
npm run runtime:status
```

In v0.5, **LocalSend normal send/receive is not a standalone runtime**. BridgeDeck compiles `vendor/localsend/packages/core` directly into the Tauri backend. Syncthing's binary goes here (built by `scripts/build-syncthing.mjs`); BridgeDeck runs it hidden.

Managed Stop only terminates child processes that BridgeDeck itself started and tracked.
