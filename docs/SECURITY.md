# BridgeDeck security notes — v0.6

BridgeDeck is a local control plane. Native integrations are deliberately constrained rather than exposing a generic remote shell.

## BridgeLink automatic pairing

- Discovery uses a dedicated LAN multicast message containing only the BridgeDeck instance ID, display name, platform and API port.
- Pairing requires explicit approval and a matching six-digit code shown on both computers.
- After pairing, remote `/status` requests require a long random bearer token. Loopback status is permitted without a token for the local BridgeDeck instance.
- Peer records and bearer tokens are persisted under the BridgeDeck app-config directory. On Unix, BridgeLink identity/peer files are written with mode `0600`.
- Pairing endpoints do not expose arbitrary command execution.
- The status endpoint is read-only.
- Pending pairing requests expire from the in-memory list.
- The pairing API includes CORS handling because the Tauri WebView queries the paired peer status endpoint directly.

### Current limitation

The initial BridgeLink pairing/token exchange in v0.6 uses local TCP and is not TLS-encrypted. The six-digit confirmation protects against accidentally approving the wrong discovered computer, but it is not a replacement for encrypted transport on a hostile network. Use automatic pairing only on a trusted LAN. A future hardening step should move the pairing exchange to authenticated TLS or an ephemeral-key handshake.

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

The Syncthing API key, BlueBubbles password, LocalSend PINs and each device's bearer token are kept
in the OS credential store (macOS Keychain, Windows Credential Manager) as a single BridgeDeck entry
(service `dev.bridgedeck.app`, account `settings-secrets`), not in `config-v7.json`. Settings saved
by older builds are migrated on first load, and the copy older builds kept in the WebView's
localStorage is deleted. If the credential store can't be read (for example Keychain access was
denied), BridgeDeck keeps the secrets in the settings file as before rather than overwriting the
stored entry.

A locally signed Mac build looks like a new app to the Keychain after each rebuild, so macOS asks
once to allow access; choose **Always Allow**.

BridgeLink pairing tokens (`bridgelink/peers.json`) and the local AI relay token (`bridgelink/ai-token`,
read by `agent/ai-relay.mjs`) are still files; BridgeLink v2 (roadmap Phase 1) replaces the pairing tokens.
