# BridgeDeck roadmap: one app, every feature built in

This replaces the v0.7 roadmap. It fixes the target design **before** building, so each phase
builds toward it instead of around the current shape. Read "Decisions" and "Target architecture"
before changing code; if a change conflicts with them, raise it with the user first.

Owners: **W** = Claude on Windows, **M** = Claude/Codex on the Mac, **C** = cloud sessions working on
the GitHub repo, **U** = the user (permissions, approvals, testing on real hardware).

---

## Goal

BridgeDeck is **one app** on every computer the user owns. Everything happens inside its window:
remote control, file transfer, folder sync, iMessage, clipboard, and AI collaboration. It never
opens another program's window or a browser tab to do its job. Views that come and go (a remote
session, an AI task room, a transfer) open as **tabs inside BridgeDeck**, like Chrome tabs: switch
to them, switch away, close them. Adding a feature adds a module and maybe a tab, never an app.

## Decisions (agreed 2026-09-29)

| # | Decision | Consequence |
|---|---|---|
| D1 | One window with a tab bar; no external windows or browser tabs | Remove every "Open …UI" / "Web UI" / "Open original RustDesk UI" button, `launch_app`, and `open_external` for app UIs |
| D2 | Remote control is BridgeDeck's own, shown in a tab | RustDesk (AGPL, separate window) is a fallback only until native remote control reaches parity, then removed |
| D3 | Syncthing runs as a hidden helper BridgeDeck owns | No Syncthing GUI, no API key typed by the user. Syncthing stays a separate, unmodified MPL-2.0 binary |
| D4 | iMessage is served by BridgeDeck on the Mac | BlueBubbles is removed |
| D5 | Matrix is removed | Tailscale covers "away from home"; the AI relay covers agent messaging |
| D6 | The AI relay stays and grows into an **AI workspace** for 2+ agents on 2+ computers | Agents, rooms, addressed messages, tasks, MCP |
| D7 | Any number of paired devices, not fixed `mac`/`windows` slots | Data model, UI, and protocol are device-list based |
| D8 | Works on the home LAN and over Tailscale | Multicast discovery on LAN, Tailscale peer list off LAN, manual address as a last resort |
| D9 | BridgeLink is encrypted and authenticated by BridgeDeck itself, even over Tailscale | Security does not depend on which network path is used |
| D10 | Git on GitHub is the source of truth; CI builds the Mac and Windows apps | Retire the `bridgedeck-source` Syncthing folder for code |
| D11 | BridgeDeck stays MIT-licensed | No AGPL/GPL code linked in (this rules out linking RustDesk and GPL iMessage parsers) |
| D12 | Two computers now; more devices later, including iPhone and iPad | Nothing assumes two devices or a desktop peer: features are negotiated by capability, and the UI must scale down to tablet/phone layouts |
| D13 | Mac and Windows installers are built in CI only for big changes and finished systems (manual run or release tag); PRs run cheap Linux checks | Keeps macOS Actions minutes low |
| D14 | Built-in iMessage limits are accepted (no tapbacks, typing indicators, edit/unsend) | No private-API work planned |
| D15 | Remote control from a paired device is allowed automatically | The host still shows the "being controlled" banner with a stop button; per-device "ask first" stays available as an option |

---

## Target architecture

```text
┌──────────────────────────── BridgeDeck window ────────────────────────────┐
│ [Home] [Files] [Sync] [Messages] [AI] │ [Windows PC – Remote ×] [Task: … ×]│  ← tab bar
├────────────────────────────────────────────────────────────────────────────┤
│  active tab (React)                                                        │
└────────────────────────────────────────────────────────────────────────────┘
        │ Tauri commands + events
┌───────▼─────────────────────── Rust core ──────────────────────────────────┐
│ Feature registry: devices · files · sync · messages · remote · clipboard · │
│                   ai-workspace · (future features)                         │
│ BridgeLink v2: identity keys · pairing · discovery (LAN + Tailscale) ·     │
│                QUIC sessions with one stream type per feature channel      │
│ Local API (127.0.0.1 only): AI clients, MCP server, scripts                │
│ Secrets: OS keychain            Settings: JSON (no secrets)               │
│ Helpers it owns: syncthing (hidden sidecar)                                │
└────────────────────────────────────────────────────────────────────────────┘
```

### Tabs

- **Fixed tabs**: Home, Files, Sync, Messages, AI. Settings opens as a tab too.
- **Dynamic tabs**: `{ id, kind, title, deviceId?, closable: true }`. Kinds planned:
  `remote-session`, `ai-room`, `transfer`, `conflict` (sync conflict review). New kinds register
  through the feature registry.
- A background tab gets a `suspended` signal; features pause expensive work (a remote session stops
  its video stream but keeps its connection). Closing a tab ends its session.
- Pop-out/full-screen is available per tab, opt-in only.
- Closing the window hides BridgeDeck to the tray/menu bar; Quit really quits.

### Feature modules

Every feature is one Rust module plus one frontend folder, registered in one list on each side.

```rust
// src-tauri/src/features/mod.rs
trait Feature: Send + Sync {
    fn id(&self) -> &'static str;                         // "sync", "remote", …
    fn capabilities(&self) -> Vec<Capability>;            // advertised to peers, versioned
    async fn start(&self, ctx: FeatureContext) -> Result<()>;
    async fn stop(&self) -> Result<()>;
    fn health(&self) -> Vec<HealthItem>;                  // shown on Home, with fix-it actions
    async fn on_stream(&self, peer: PeerId, stream: Stream) -> Result<()>; // incoming BridgeLink channel
}
```

```ts
// src/features/<id>/index.ts
export const feature: FeatureManifest = {
  id, title, icon,
  fixedTab?: Component,              // e.g. Files page
  tabKinds?: Record<string, Component>, // e.g. { 'remote-session': RemoteSessionTab }
  settings?: Component,              // section inside the Settings tab
  deviceActions?: DeviceAction[],    // buttons on a device card ("Control", "Send files")
}
```

The shell (tab bar, device list, Home health, Settings) is built from the registry. It never
hard-codes a feature.

### Devices

`Device { id (identity public-key fingerprint), name, platform, addresses[], lastSeen, capabilities, buildVersion }`.
Addresses are tried in order: LAN, Tailscale (MagicDNS name and 100.x address), manual.
Per-feature data (Syncthing device ID, etc.) lives with the feature, keyed by device ID, instead of
being fields on the device.

### BridgeLink v2 (transport)

- **Identity**: each install creates a long-term key pair on first run (private key in the keychain).
- **Pairing**: X25519 key exchange; the six-digit code shown on both screens is **derived from the
  shared secret**, so matching codes prove nobody is in the middle. The user approves on both sides.
  Result: both devices pin each other's public key. No bearer tokens cross the network.
- **Sessions**: QUIC (`quinn` + `rustls`) with certificates pinned to the paired keys. One connection
  per device pair; each feature opens its own streams (reliable) or datagrams (remote video) on it,
  so a large file transfer never blocks a chat message or a mouse click.
- **Handshake**: protocol version + capability list + app build version. Features only use
  capabilities both sides advertise; Home warns when builds differ.
- **Discovery**: LAN multicast (existing, UDP 41415) + Tailscale (`tailscale status --json` lists the
  user's devices; BridgeDeck probes them) + manual address. Multicast does not cross Tailscale,
  which is why the second source exists.
- **Offline queue**: messages for an offline device (AI, clipboard text, contact edits) are queued
  and delivered when it reconnects, with an expiry.
- **Local API**: HTTP on `127.0.0.1` only, for AI clients, the MCP server and scripts. It requires the
  local AI token, and CORS allows only the Tauri origin. Nothing but QUIC listens on the LAN.

### Storage

- Settings: JSON in the app-config folder, **no secrets**; the frontend stops mirroring config into
  `localStorage`.
- Secrets: OS keychain via the `keyring` crate (macOS Keychain, Windows Credential Manager).
- Feature data (AI rooms, message cache, transfer history): SQLite (`rusqlite`) per feature.

### Platform baseline

macOS 13+ (ScreenCaptureKit, WebCodecs in WKWebView), Windows 10 1903+ (Windows Graphics Capture,
WebView2). The bundle's `LSMinimumSystemVersion` moves from 10.13 to 13.0.

---

## Features

### Devices & Home
- Device list (any number), status, build version, Wake-on-LAN, "Pair new device", "Forget".
- Home is a health checklist built from every feature's `health()`: permission missing, helper
  stopped, device offline, builds differ. Each item has a fix-it button.

### Files (LocalSend core, already built in)
- Keep the embedded LocalSend core: it also interoperates with the LocalSend app on phones.
- Paired computers are addressed by their BridgeLink addresses (so it works over Tailscale too);
  transfers from paired devices are auto-accepted, others ask.
- Each transfer can open a `transfer` tab with progress; drag-and-drop onto a device card.
- OS integration: Explorer "Send to", Finder Quick Action.

### Sync (Syncthing as a hidden helper)
- Syncthing is built from the pinned source in `vendor/` and bundled as a Tauri sidecar (`externalBin`).
- BridgeDeck starts it with its own home folder inside BridgeDeck's app data, no browser, GUI/API on
  `127.0.0.1` with a random port, and an API key BridgeDeck generates and keeps in the keychain.
  BridgeDeck stops it on quit.
- Device IDs are exchanged over BridgeLink (as today); device addresses include the Tailscale address.
- UI: folders, per-device progress, pause/resume, add folder, ignore patterns, and a `conflict` tab
  to compare and resolve `*.sync-conflict-*` files.
- **Migration**: when an existing Syncthing install is found, offer to adopt it: copy its keys and
  config so the device ID and folders (`bridgedeck-shared`) stay the same, then stop and disable the
  standalone copy.

### Messages (iMessage served by the Mac)
- On the Mac, a native engine: reads `~/Library/Messages/chat.db` read-only (`rusqlite`), watches it
  for changes, serves attachments, reads Contacts, and sends through Messages.app with AppleScript
  (text and files). Needs Full Disk Access + Automation for BridgeDeck only.
- Newer macOS stores text in `attributedBody` (a serialized `NSAttributedString`); BridgeDeck needs
  its own decoder, because the common open-source one (`imessage-database`) is GPL (D11).
- Other devices get chats, messages and attachments over a `messages` BridgeLink channel; sends and
  contact edits go back the same way (keeping the Allow/Deny dialog and rate limit for contact edits).
- Known limits without Apple's private APIs: no tapbacks, typing indicators, edit/unsend or sending
  read receipts. Text, group chats, attachments and SMS (with iPhone Text Message Forwarding) work.

### Remote control (native, in tabs)
- **Host side** (the computer being controlled): capture with ScreenCaptureKit (macOS) / Windows
  Graphics Capture; hardware H.264 encode (VideoToolbox / Media Foundation), software fallback;
  inject input with CGEvent (macOS) / SendInput (Windows).
- **Viewer side**: a `remote-session` tab decodes with WebCodecs `VideoDecoder` into a canvas and
  sends mouse, keyboard and scroll events back. Cmd/Ctrl mapping, monitor picker, quality/bitrate
  that adapts to the link, and shared clipboard while in a session.
- **Transport**: video on QUIC datagrams, input on a reliable stream.
- **Safety**: paired devices connect automatically (D15); unpaired devices never can. The host always
  shows a "being controlled by …" banner with a stop button and hotkey, and each device can be
  switched to "ask first" in Settings.
- Known limit: Windows UAC prompts appear on the secure desktop and can't be controlled unless
  a SYSTEM service is added later.
- RustDesk stays available (hidden, as today) until this reaches parity, then its code, vendor
  tree and settings are removed.

### Clipboard sync
- Text and images between paired devices; toggle per device; off until BridgeLink v2 ships.
- Loop prevention (don't echo back what was just received) and a size limit; files go via Files.

### AI workspace (the relay, extended)
- **Agents**: each assistant registers a name (`claude-windows`, `codex-mac`, …) with its local
  BridgeDeck; the AI tab shows who is online on every device.
- **Rooms**: one per task, with participants, conversation, status (open / in progress / done) and
  assignments. Each room can open as an `ai-room` tab.
- **Addressing**: messages go to one agent, a group, or the whole room, on this device or any other.
  Agents on the same computer can talk to each other.
- **Delivery**: fan-out to every device with a participant; SQLite store per device; message IDs are
  ULIDs, deduplicated; offline queue.
- **Tools**: an MCP server (`agent/bridgedeck-mcp`) exposing send / read / wait / rooms / tasks /
  device status / sync status; file claims (`claim`, `release`) so agents don't edit the same file.
- **Compatibility**: `agent/ai-relay.mjs` and the Claude Code hook keep working; `--to` and `--room`
  are additions.
- **Safety**: message bodies are data, never instructions; anything with side effects needs the
  local human's approval; the human can read and post in every room.

### Tray / menu bar, notifications, updates
- Tray icon with status, Send files, Control…, Open shared folder.
- Notifications: file received, message for the human, device offline, update available.
- Auto-update from GitHub Releases (`tauri-plugin-updater`), so both computers get the same build
  without rebuilding by hand.

### Removed
Matrix (UI, commands, config, vendor pin) · BlueBubbles (server, client pin, adapter) · RustDesk
(after parity) · the Services page and service manager · `launch_app` · `open_external` for app UIs
(the opener plugin stays for opening folders and ordinary links, without `cmd /C start`).

---

## Phases

Each phase ends with both computers on the new build and its checks passing.

### Phase 0: Foundation
| # | Task | Done when |
|---|---|---|
| 0.1 | Split `src/App.tsx` into `src/shell/` (tab bar, device list, Home, Settings) and `src/features/<id>/`; feature registry on both sides | Same behaviour as v0.7, no page code in the shell |
| 0.2 | Tab bar with fixed + dynamic tabs and the `suspended` signal | Opening/closing a dummy dynamic tab works |
| 0.3 | Device-list data model (D7) with a config migration from the `mac`/`windows` slots. Feature fields (RustDesk ID, LocalSend target, Syncthing ID) stay on the device record until the phase that rebuilds each feature moves them into it | Existing pairing survives the upgrade |
| 0.4 | Remove Matrix; replace `cmd /C start` with `tauri-plugin-opener`. The "Open …UI" buttons stay as fallbacks until the phase that builds each feature in removes them | Audit HIGH #1 closed |
| 0.5 | Secrets to the keychain, settings JSON without secrets, no config in `localStorage` | Audit MEDIUM closed |
| 0.6 | GitHub Actions: on every PR, Linux checks (typecheck, frontend build, `verify:project`, Rust tests); Mac + Windows installers only on manual run or release tag (D13) | PRs are checked cheaply; a release produces both installers |
| 0.7 | Git replaces the `bridgedeck-source` Syncthing folder; update `SOURCE_SYNC.md` / START-HERE docs | Both computers work from clones |
| 0.8 | Close-to-tray, version shown on device cards | |

### Phase 1: BridgeLink v2
| # | Task | Done when |
|---|---|---|
| 1.1 | Identity keys, SAS pairing, pinned keys | Tokens never cross the network; audit HIGH #2 closed |
| 1.2 | QUIC sessions with per-feature streams; capability + version handshake | Status and AI relay run over v2 |
| 1.3 | Tailscale discovery + address list per device | Pairing and status work with the Mac away from home |
| 1.4 | Offline queue; local API loopback-only, CORS locked to the Tauri origin | Audit MEDIUM closed |
| 1.5 | One-time re-pair on upgrade (v1 tokens rejected) | U |

### Phase 2: Sync built in
Sidecar build + bundling, owned config and API key, adoption of the existing install, sync UI,
conflict tab. **Done when** Syncthing is never visible as its own app and `bridgedeck-shared` keeps
syncing with the same device IDs.

### Phase 3: AI workspace
Agents, rooms, addressing, multi-device fan-out, SQLite store, MCP server, file claims, task board,
room tabs. **Done when** three agents on two computers can work in one room, with one addressed
message delivered only to its recipient, and old `ai-relay.mjs` commands still work.

### Phase 4: Messages built in
chat.db reader + `attributedBody` decoder, change watcher, attachments, contacts, AppleScript send,
`messages` channel, Messages UI switched over, BlueBubbles removed. **Done when** the user can read
and send iMessages on Windows with BlueBubbles uninstalled.

### Phase 5: Remote control built in
Host capture/encode/input per platform, viewer tab, consent + banner, adaptive quality, then
RustDesk removal. **Done when** each computer can control the other from a tab, over LAN and
Tailscale, with no RustDesk installed.

### Phase 6: Everyday
Clipboard sync, tray actions, Send to / Quick Action, notifications, Home health fix-its, auto-update.

### Phase 7: Mobile and extras
- **iPhone / iPad (D12)**: a BridgeDeck mobile build (Tauri 2 supports iOS) that pairs like any
  device and uses the capabilities iOS allows: remote-control viewer, Files (LocalSend protocol),
  clipboard, AI rooms, Messages viewer (served by the Mac), notifications. iOS cannot host remote
  control, run the Syncthing helper, or stay connected in the background, so those capabilities are
  simply not advertised.
- Wake-on-LAN button, audio in remote sessions, a SYSTEM service on Windows for UAC prompts, code
  signing and notarisation.

Order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Rust tests for pairing, crypto and protocol code are
written together with Phase 1, not after it.

---

## Open questions

None at the moment. Answers from 2026-09-29 are recorded as D12–D15.

---

## Where things stand (2026-09-29)

**Phase 0 is built** (0.8.0), compile-checked for Linux and Windows and unit-tested, but not yet run on
the Mac or Windows hardware. Next: test it on both computers, then Phase 1.

| Area | State |
|---|---|
| App shell | Tab bar with fixed and closable tabs; features are modules in `src/features/<id>`; closes to tray |
| Devices | Any number; v0.7 settings migrate; versions shown, mismatch warned on Home |
| Pairing (BridgeLink v1) | Works on the LAN; plaintext pairing tokens (audit HIGH #2, Phase 1) |
| AI relay | Works between two computers; one agent per side sees the other side's messages (Phase 3) |
| Files | LocalSend core built in; auto-accept from paired computers |
| Sync | Uses a separately installed Syncthing (Phase 2) |
| Remote | RustDesk launched as a separate app (Phase 5) |
| Messages | Needs BlueBubbles Server (Phase 4) |
| Security | `cmd /C start` fixed; settings secrets in the OS keychain; open: plaintext pairing, wildcard CORS (Phase 1) |
| Engineering | GitHub is the source of truth; CI workflows added; vitest + Rust unit tests; Matrix removed |
