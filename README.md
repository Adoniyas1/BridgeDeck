# BridgeDeck v0.7 — automatic Mac ↔ Windows pairing + shared workspace

BridgeDeck is a Tauri + React desktop control center that combines editable open-source Mac/Windows connectivity engines behind one interface. Upstream source remains pinned under `vendor/`; BridgeDeck-owned integration lives in `src/` and `src-tauri/`.

## What changed in v0.7

### Automatic Syncthing device + folder setup

Once Mac and Windows are paired through BridgeLink, BridgeDeck can now configure the persistent shared workspace automatically:

- reads the **local** Syncthing device ID from the local REST API;
- exchanges only device IDs through BridgeLink pairing/status metadata;
- never sends the local Syncthing REST API key to the other computer;
- adds the paired computer to local Syncthing when missing;
- creates `bridgedeck-shared` / **BridgeDeck Shared** when missing;
- preserves existing folder settings if that folder ID already exists and only adds the missing peer to its device list;
- defaults the local path to `~/BridgeDeck Shared` when no path is configured;
- keeps the same folder ID across Mac and Windows while allowing different local paths;
- refreshes older v0.6 pair records over the authenticated BridgeLink status channel to learn the peer's Syncthing ID;
- shows **Setup sync** controls in Computers and Sync;
- stores the resolved local shared path on the matching Mac/Windows machine card.

Syncthing's REST API uses an API key locally, and BridgeDeck uses Syncthing's granular `/rest/config/devices` and `/rest/config/folders` endpoints instead of replacing the whole configuration.

### BridgeLink remains the one-time machine pairing layer

BridgeLink still provides LAN discovery, a six-digit approval code, persisted bearer-token authentication, RustDesk ID exchange, LocalSend endpoint exchange, and machine status. v0.7 adds Syncthing device ID exchange to that metadata.

> **Security boundary:** Pair only on a trusted home/work LAN and verify the six-digit code on both computers. The initial BridgeLink pairing/token exchange is not yet TLS-encrypted. Syncthing API keys stay local and are never sent through BridgeLink.

### Native LocalSend and RustDesk behavior

- LocalSend send/receive continues to run through the pinned vendored Rust core inside BridgeDeck.
- RustDesk continues to provide the actual remote-session authentication, transport, and renderer while BridgeDeck owns peer/session selection.

## Architecture

```text
BridgeDeck UI
│
├── Computers ── BridgeLink ───────── Mac ↔ Windows pairing/status/metadata
├── Remote ───── native adapter ───── RustDesk runtime/source
├── Files ────── native Rust ──────── LocalSend core source
├── Sync ─────── native HTTP ──────── Syncthing REST config + shared workspace
├── Messages ─── native HTTP ──────── BlueBubbles Server
└── AI Center ── native HTTP ──────── Matrix
```

## Source layout

```text
bridgedeck-v0.7/
├── src/                              React dashboard
├── src-tauri/
│   └── src/
│       ├── bridgelink.rs             LAN discovery/pairing/status metadata
│       ├── localsend_bridge.rs       native LocalSend integration
│       ├── syncthing_bridge.rs       automatic device/folder configuration
│       └── lib.rs                    Tauri/native integrations
├── docs/
│   └── SYNCTHING_AUTO_SETUP.md
├── vendor/                           pinned editable upstream source
└── runtime/                          built standalone runtimes where needed
```

## Upgrade using your existing vendored source

If an older BridgeDeck directory already contains your verified upstream source:

```bash
cd ~/Downloads
unzip BridgeDeck-v0.7-auto-sync-bootstrap.zip
cd bridgedeck-v0.7
./scripts/upgrade-from-previous.sh ../bridgedeck-v0.6/bridgedeck-v0.6
```

Point the script at whichever previous BridgeDeck directory actually contains `vendor/`.

## Install and run

```bash
npm install
npm run verify:project
npm run vendor:verify
npm run verify:localsend-core
npm run tauri dev
```

Run the same v0.7 build on both computers.

## Enable automatic shared workspace

On **each** computer:

1. Make sure Syncthing is running.
2. In **Settings → Syncthing**, enter that computer's local REST API key.
3. Leave **Automatically configure Syncthing after BridgeLink pairing** enabled.
4. Leave the folder path blank for `~/BridgeDeck Shared`, or choose a different local path.
5. Pair the two BridgeDeck instances, or press **Setup sync** on an already paired v0.6/v0.7 computer.

BridgeDeck will configure each local Syncthing instance using its own API key. The API key is not exchanged.

## Firewall ports

Typical LAN permissions:

- UDP `41415` — BridgeLink discovery;
- TCP `41416` — BridgeLink status/pairing API;
- TCP/UDP `53317` — LocalSend;
- Syncthing's normal sync/discovery ports according to your Syncthing configuration;
- RustDesk ports according to your RustDesk configuration.

The Syncthing REST GUI/API should normally remain bound to localhost (`127.0.0.1:8384`) because BridgeDeck configures it locally on each computer.

## Useful commands

```bash
npm run verify:project
npm run vendor:verify
npm run verify:localsend-core
npm run runtime:status
npm run tauri dev
npm run tauri build
npm run package:source
```
