# Automatic Syncthing setup

BridgeDeck v0.7 can turn a completed BridgeLink Mac/Windows pairing into a Syncthing device relationship and a shared workspace without sending the Syncthing API key to the other computer.

## Trust model

- Each computer keeps its own Syncthing REST API key locally.
- BridgeLink exchanges only the Syncthing device ID alongside RustDesk and LocalSend metadata.
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
