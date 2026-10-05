# BridgeDeck architecture (0.9)

BridgeDeck is one desktop app (Tauri 2: a Rust backend and a React UI in the system WebView) that
connects your computers: devices, files, sync, messages, remote control and an AI workspace, each
a tab. Nothing opens in a separate window. See `ROADMAP.md` for the plan and its decisions.

```text
┌──────────────────────────── BridgeDeck (one window, tabs) ────────────────────────────┐
│ React UI  src/shell (tab bar, settings) · src/core (stores, config, BridgeLink state) │
│           src/features/<id> (home, devices, remote, messages, ai, files, sync, …)    │
├──────────────────────────────── Tauri commands / channels ────────────────────────────┤
│ Rust      link/        QUIC transport, identity, pairing codes                        │
│           bridgelink/  discovery, pairing, peer API, loopback API, AI workspace       │
│           remote/      screen sharing and control (host + viewer)                     │
│           imessage/    Messages read from chat.db and sent with Messages.app (Mac)    │
│           sync_sidecar.rs, syncthing_bridge.rs, sync_conflicts.rs   Syncthing helper  │
│           localsend_bridge.rs  LocalSend core linked in                               │
│           secrets.rs, tray.rs, upgrade.rs, lib.rs                                     │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

## Frontend

- **Features** register a `FeatureManifest` in `src/features/registry.ts`: a fixed tab (`Page`),
  background work (`Background`, mounted once, may render a banner), a Settings section, a badge
  store, and dynamic tab kinds (`tabKinds`), for example `remote-session`, `ai-room`,
  `sync-conflicts`. `openTab({ kind, params })` opens or focuses a closable tab.
- **State** is small stores (`createStore`/`useStore`). Settings are `AppConfig`
  (`src/lib/config.ts`, migrated from older versions), saved natively; secrets go to the OS
  credential store (`secrets.rs`).
- `src/lib/bridge.ts` wraps every native command; outside Tauri (browser dev mode) calls degrade.

## Devices and BridgeLink

- **Identity**: each install has a self-signed certificate (`link/identity.rs`, `identity-v2.json`);
  its SHA-256 fingerprint is the device's identity.
- **Discovery**: LAN multicast on UDP 41415 plus Tailscale (`tailscale status --json`, unicast
  announcements), so devices find each other on the tailnet too. Each device keeps the addresses a
  peer was seen at, preferring LAN.
- **Pairing** (`bridgelink/peer.rs`): numeric comparison with a commitment. Both screens show the
  same six-digit code only if nobody is in the middle; both people confirm; each side pins the
  other's certificate. No token crosses the network.
- **Transport** (`link/transport.rs`): QUIC (quinn, TLS 1.3) on UDP 41416, one connection per
  device pair, a stream per request (4-byte length + JSON), long-lived streams for pairing and
  remote sessions, raw frames for video. The server side only answers devices whose certificate
  is pinned (`401` otherwise).
- **Peer API** (paired devices, over QUIC): `/status`, `/ai/inbox`, `/ai/state`, `/messages`,
  `/contacts/save`, `/upgrade/*`, and the `/remote/session` stream.
- **Loopback API** (`bridgelink/local.rs`, `127.0.0.1:41416` TCP): for this computer's AI tools and
  scripts; `/ai/*` needs the local AI token; browser origins other than BridgeDeck's are refused.

## Features

| Tab | How it works |
|---|---|
| Devices | Pairing UI, device list, versions, "Pair again" for 0.8 pairings. |
| Files | LocalSend core compiled in (`vendor/localsend`); paired devices auto-accepted. |
| Sync | Syncthing runs hidden as a sidecar owned by BridgeDeck (`sync_sidecar.rs`: own home folder, loopback GUI with a random key, restarted if it stops, stopped on quit; an existing install can be adopted). Folders, progress, pause, conflicts tab (the losing copy goes to the Trash). |
| Messages | On the Mac, `imessage/` reads `chat.db` and Contacts read-only (`attributedBody` decoded by `typedstream.rs`), converts HEIC for display, and sends text and files through Messages.app with AppleScript. Other devices ask the Mac over `/messages`; attachments move in 512 KB chunks. |
| Remote | `remote/host.rs` captures a monitor (`xcap`) and injects input (`enigo`) on their own threads; `codec.rs` sends only changed 128-px tiles as JPEG (the whole frame when most changed); the viewer asks for the next frame after drawing, so the rate adapts. `remote/viewer.rs` feeds a `remote-session` tab through a Tauri channel. Paired devices only; banner + tray Stop on the host. |
| AI Center | `bridgelink/workspace.rs`: agents, rooms with to-dos, file claims and addressed messages, replicated to every paired device (`/ai/state`, merged by last update). `agent/bridgedeck-mcp.mjs` gives any MCP client the tools; `agent/ai-relay.mjs` is the CLI. See `AI_RELAY.md`. |

## Data on disk

App config folder (`dev.bridgedeck.app`): `config-v7.json` (settings, no secrets),
`bridgelink/identity*.json`, `peers-v2.json`, `ai-token`, `ai-messages.jsonl`, `ai-workspace.json`,
`outbox.json`, and `syncthing/` (the sidecar's home). Secrets: one OS credential-store entry.

## Build and checks

- `npm run build`, `npm test` (vitest), `npm run verify:project` (static guards).
- `cargo check`, `cargo test` in `src-tauri`; Windows is cross-checked with
  `--target x86_64-pc-windows-gnu`. macOS code is compiled by `release.yml` (releases the app installs itself, run on
  demand for big changes, D13).
- `vendor/` holds pinned upstream source (`vendor-lock.json`: Syncthing, LocalSend);
  `scripts/build-syncthing.mjs` builds the sidecar.
