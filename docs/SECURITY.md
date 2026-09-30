# BridgeDeck security notes

BridgeDeck is a local control plane. Native integrations are deliberately constrained rather than exposing a generic remote shell.

## BridgeLink v2 (0.9): pairing and the encrypted link

- **Identity.** Each install creates a long-term key pair and a self-signed certificate on first run
  (`bridgelink/identity-v2.json`, mode `0600` on Unix). The certificate's SHA-256 fingerprint is the
  device's identity; the private key never leaves the device.
- **Pairing** is numeric comparison with a commitment (as in Bluetooth Secure Simple Pairing), over a
  TLS 1.3 QUIC connection: the responder commits to a random nonce before seeing the initiator's; both
  compute a six-digit code from both certificates and both nonces. A device in the middle sees different
  certificates on each side, so the two screens show different codes unless it wins a one-in-a-million
  guess, and every attempt is a visible pairing request. **Both people confirm** ("Codes match") before
  either side stores anything. Code: `src-tauri/src/link/sas.rs`, `src-tauri/src/bridgelink/peer.rs`.
- **After pairing** each side pins the other's certificate fingerprint (`bridgelink/peers-v2.json`). Every
  connection is mutually authenticated TLS 1.3 over QUIC (UDP 41416); a request from a certificate that
  isn't paired gets nothing but pairing. No password or token crosses the network, and there is nothing
  to steal from the settings file that would let another device impersonate a paired one.
- **Discovery** announcements (UDP 41415, multicast on the LAN and direct to Tailscale devices) carry only
  the instance ID, name, platform and port. They are hints: an announcement can move where BridgeDeck
  looks for a device, never whom it trusts.
- **The HTTP API** listens on `127.0.0.1` only (this computer's AI tools and BridgeDeck's own status).
  Requests with an `Origin` header are refused unless it is BridgeDeck's own WebView, so web pages can't
  use it; `/ai/*` also needs the local AI token.
- **Upgrading from 0.8.** Old pairings (plaintext bearer tokens) are not used any more. They are listed
  under "Pair again"; the one thing BridgeDeck still does with an old token is ask that device to update
  itself (its user approves there), so it can then be paired securely.

## LocalSend

- Manual acceptance is the default for incoming transfers.
- Optional receiver PIN is enforced by the upstream LocalSend protocol server.
- The local receiver PIN is separate from each remote target's send PIN.
- Sender-supplied checksums are verified.
- Absolute paths, parent traversal and platform path prefixes in incoming names are rejected.
- Existing filenames are not silently overwritten; a unique name is allocated.
- Symlink roots are rejected for outbound transfers and directory walking does not follow symlinks.
- The LocalSend certificate/private key is persisted so the device fingerprint remains stable. On Unix, the identity file is mode `0600`.

## RustDesk

BridgeDeck only accepts numeric peer IDs and invokes RustDesk with direct process arguments. RustDesk continues to own session authentication, transport encryption and remote-display rendering.

## Legacy Bridge Agent

The standalone agent remains read-only. Loopback mode requires no token. Non-loopback/LAN mode refuses to start without a bearer token. BridgeLink makes the standalone agent optional for normal paired-machine status.

## Service manager

Only known service identifiers can be managed. BridgeDeck only stops child processes that BridgeDeck itself started.

## Syncthing automation in v0.7

The Syncthing REST API key is a local administrative credential. BridgeDeck uses it only from the local native process to call the local Syncthing REST API. It is not added to BridgeLink pairing payloads, peer records, or remote status responses. Only the Syncthing device ID is exchanged; device IDs are public identifiers derived from Syncthing's device certificate/public key.

Automatic setup creates or patches only the configured BridgeDeck folder/device relationship. Forgetting a BridgeLink peer does not automatically delete Syncthing folders or data.

## Settings secrets (v0.8)

The Syncthing API key, BlueBubbles password, LocalSend PINs and any hand-entered device token are kept
in the OS credential store (macOS Keychain, Windows Credential Manager) as a single BridgeDeck entry
(service `dev.bridgedeck.app`, account `settings-secrets`), not in `config-v7.json`. Settings saved
by older builds are migrated on first load, and the copy older builds kept in the WebView's
localStorage is deleted. If the credential store can't be read (for example Keychain access was
denied), BridgeDeck keeps the secrets in the settings file as before rather than overwriting the
stored entry.

A locally signed Mac build looks like a new app to the Keychain after each rebuild, so macOS asks
once to allow access; choose **Always Allow**.

The BridgeLink identity key (`bridgelink/identity-v2.json`) and the local AI relay token (`bridgelink/ai-token`,
read by `agent/ai-relay.mjs`) are user-only files.
