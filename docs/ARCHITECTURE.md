# BridgeDeck v0.7 architecture

BridgeDeck is a Tauri desktop shell with a React UI and a Rust native backend.

## Native integration layers

- `src-tauri/src/bridgelink.rs` — BridgeDeck LAN discovery, approval-code pairing, persisted peer tokens, and read-only paired-machine status API.
- `src-tauri/src/localsend_bridge.rs` — direct LocalSend core integration for send/receive/discovery.
- `src-tauri/src/lib.rs` — RustDesk launch/session adapter, Syncthing/BlueBubbles adapters, service management and native config persistence.

## BridgeLink flow

```text
Mac BridgeDeck                           Windows BridgeDeck
     │                                         │
     ├──── UDP 41415 multicast discovery ─────┤
     │                                         │
     ├── POST /pair/request ──────────────────►│
     │       six-digit code                    │
     │                                         │ user approves
     │◄──── GET /pair/status = approved ───────┤
     │       peer token + RustDesk ID           │
     │       + LocalSend endpoint               │
     │                                         │
     └──── authenticated GET /status ◄─────────┘
```

The UI maps a paired peer to the existing `mac` or `windows` machine slot according to the peer platform. Manual settings remain available.

## Vendor/runtime model

`vendor/` contains pinned editable upstream source. `runtime/` contains standalone binaries where BridgeDeck still launches an upstream runtime (for example RustDesk). LocalSend is compiled directly into BridgeDeck via a Cargo path dependency.
