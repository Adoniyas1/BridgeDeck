# Syncthing in BridgeDeck

## Built in (0.9)

BridgeDeck ships the pinned, unmodified Syncthing (`vendor/syncthing`, built by
`scripts/build-syncthing.mjs` into `runtime/<platform>/syncthing/`) and runs it as a hidden helper
(`src-tauri/src/sync_sidecar.rs`):

- its own home folder inside BridgeDeck's app-config folder (`syncthing/`), so it never touches a
  separately installed Syncthing;
- `serve --no-browser --no-restart --no-upgrade`, the web UI/API on `127.0.0.1` at a free port, with an
  API key BridgeDeck generates; no "Default Folder" is created;
- started with BridgeDeck, restarted if it exits (up to 5 times in 10 minutes), stopped on quit.

**Moving an existing Syncthing in.** When a separately installed Syncthing is found, the Sync tab offers
"Move into BridgeDeck": BridgeDeck stops it through its API, copies its certificate (device ID), settings
and database, and starts its own copy. Paired devices and shared folders keep working. Remove the old
Syncthing app from your login items afterwards. Setups that used a separate Syncthing before 0.9 keep
using it (Settings → Syncthing → "Run Syncthing inside BridgeDeck" is off) until you move it in.

**Sync tab.** Folder progress, pause/resume, "Share a folder" (shares with every paired device), stop
syncing a folder (files stay), and a **Conflicts** tab per folder: when a file was changed on two computers
before they synced, pick the version to keep; the other goes to the Trash / Recycle Bin.

**Addresses.** When BridgeDeck adds a paired computer to Syncthing it includes the address BridgeLink last
reached it at (LAN or Tailscale) next to Syncthing's own discovery, and updates it when the computer moves.

All Syncthing API calls go to `127.0.0.1` only; the API key never leaves the computer.

# Automatic Syncthing setup

BridgeDeck v0.7 can turn a completed BridgeLink Mac/Windows pairing into a Syncthing device relationship and a shared workspace without sending the Syncthing API key to the other computer.

## Trust model

- Each computer keeps its own Syncthing REST API key locally.
- BridgeLink exchanges only the Syncthing device ID alongside LocalSend metadata.
- Syncthing device IDs are public-key-derived identifiers and are not secrets.
- The BridgeLink initial pairing transport is still intended for trusted LANs; confirm the six-digit code on both screens.

## Setup flow

1. BridgeDeck calls the local Syncthing `/rest/system/status` endpoint and learns `myID`.
2. BridgeLink pairing exchanges each computer's Syncthing device ID.
3. On each computer, BridgeDeck checks `/rest/config/devices` and creates the remote device from `/rest/config/defaults/device` only when missing.
4. BridgeDeck checks `/rest/config/folders` for the configured folder ID (default `bridgedeck-shared`).
5. If missing, BridgeDeck creates it from `/rest/config/defaults/folder` with a local path and shares it with both device IDs.
6. If the folder already exists, BridgeDeck preserves its existing settings and only patches its `devices` array when the peer is missing.
7. BridgeDeck performs a best-effort folder scan and reports whether Syncthing says a restart is required.

## Defaults

- Folder ID: `bridgedeck-shared`
- Label: `BridgeDeck Shared`
- Local path: `~/BridgeDeck Shared` when the setting is blank
- Folder mode: `sendreceive` when BridgeDeck creates the folder

Each machine may use a different local path while sharing the same folder ID.

## Existing v0.6 pairings

A v0.6 peer record does not contain a Syncthing device ID. v0.7's **Setup sync** action first calls the peer's authenticated BridgeLink `/status` endpoint to refresh metadata. This allows an existing pairing to gain the Syncthing device ID without deleting and recreating the pairing, as long as both computers are running v0.7 and Syncthing is reachable locally on each side.

## What forgetting a BridgeLink peer does not do

For safety, **Forget pairing** does not delete Syncthing devices or folders. Syncthing data and sharing configuration are left intact to avoid destructive surprises. Remove them from Syncthing separately if desired.
