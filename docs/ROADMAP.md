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
All built (PR #10); none of it has run on Mac or Windows hardware yet.

- **Clipboard sync (built)**: a thread in `clipboard.rs` owns the system clipboard. Changes are noticed
  by the Mac's pasteboard change count and Windows' clipboard sequence number (Linux compares text).
  Text and pictures (PNG) go to every paired device on a `/clipboard` stream; nothing is queued for
  devices that are off. What password managers mark as concealed (nspasteboard.org types on the Mac,
  `ExcludeClipboardContentFromMonitorProcessing` on Windows) is never sent. On by default; one toggle
  on the Computers tab turns sending and receiving off on that computer.
- **Notifications (built)**: Settings → Notifications turns each kind on or off: iMessages, AI
  messages (shown by the native side), files received or waiting for Accept, and new Syncthing
  conflict copies (looked for every 5 minutes, and every minute while the Sync tab is open). Remote
  control starting and pairing requests always notify.
- **Tray actions (built)**: the tray / menu-bar menu lists paired computers under Control and Send
  files to (a file picker, then LocalSend), and has a Share clipboard switch. The UI sends the device
  list with `tray_update` whenever it changes; picks come back as `tray-action` events.
- **Send to / Open With (built)**: Windows gets a BridgeDeck shortcut in Explorer's Send to menu
  (rewritten at each start, removable in Settings → Files); it starts BridgeDeck with `--send`, and
  the single-instance plugin hands the paths to the running app. On the Mac, the bundle declares
  `public.data`/`public.folder` as an Alternate viewer, so BridgeDeck is under Open With and takes
  files dropped on its Dock icon (`RunEvent::Opened`). The files wait in the Files tab for a computer
  to be picked.
- **Home health fix-its (built)**: a "Needs attention" card on Home lists what's wrong, each with the
  click that fixes it: pairing stopped or nothing paired, Messages without Full Disk Access, remote
  control without Screen Recording or Accessibility (checked without prompting via
  `CGPreflightScreenCaptureAccess` / `AXIsProcessTrusted`), built-in sync or file receiving stopped,
  sync conflicts, and a clipboard that couldn't be opened. The Mac buttons open the exact
  Privacy & Security pane. Start-up states are ignored for the first 20 seconds.
- **Auto-update (built)**: every six hours (and at start) BridgeDeck runs `git fetch` in its clone
  and counts the commits it's missing on its branch's upstream. New changes are announced once and
  offered on Home ("Update" runs the existing GitHub upgrade: pull, rebuild, restart). Settings →
  Computers → Updates can install them automatically, never while this computer is being controlled,
  and not again for a day after a failed update. Installed builds without a clone can't update
  themselves yet (the Tauri updater needs a signing key; Phase 7 with code signing).

### Mimir (built, 2026-10-01)
Mimir, the self-editing assistant from `Adoniyas1/mimir` (commit 23b15bc), now lives in `mimir/` and
runs inside BridgeDeck instead of as an Electron app:
- Its main process is a Node server (`mimir/src/main/server.ts`) that serves the renderer on
  127.0.0.1 and carries Electron's IPC channels over a token-protected WebSocket; the renderer's
  `bridge.ts` is the new `window.mimir`. PDF export uses pdfkit instead of Chromium printing.
- BridgeDeck's `mimir_host.rs` installs and builds it on first use (`npm ci`, `npm run build`),
  starts it with BridgeDeck, restarts it on exit 75 (a self-edit) or a crash (gives up after 5 in
  5 minutes), turns `MIMIR_NOTIFY` lines into notifications, and owns the voice shortcut
  (Cmd/Ctrl+Shift+Space) while it runs.
- The Mimir tab shows its page in an iframe (CSP `frame-src http://127.0.0.1:*`); the Mac build
  asks for the microphone and camera (`src-tauri/Info.plist`).
- `server-entry.mjs` keeps the immutable-launcher rule: self-edited builds run from the workspace,
  and three starts in a row that never got healthy fall back to the original.
- Not tried on hardware yet: microphone access inside the tab (WKWebView / WebView2 permission
  prompts) is the part most likely to need work.

### Phase 8: Reliable, faster, Notes & Calendar, Mimir maximized (planned 2026-10-01)
One PR each, in this order:
1. **Diagnostics + Mimir fixes (built)**: "Copy diagnostics" on Home and in Settings collects a
   redacted report from this computer and every paired one (`diagnostics.rs`, `GET /diagnostics`).
   Mimir: switching its brain to Claude no longer keeps the Ollama model name (Claude rejected it),
   Claude models get a picker (default Claude Opus 5.5), refusals show a message, and requests opt
   into the server-side refusal fallback.
2. **First-run setup (built)**: a checklist (pair, Mac permissions, sync, files, Mimir, notifications) with
   live ticks, built on the "Needs attention" checks.
3. **Notes & Checklists (built)**: block notes (headings, lists, checklists, quotes, code) with
   Markdown shortcuts, folders, pins, search, due dates and reminders; synced between paired computers
   with per-paragraph merging (`notes.rs`, `/notes/pull`); Copy as Markdown. Also fixed: requests
   arriving on a connection this computer opened were never answered.
4. **Calendar (built)**: day/week/month, repeating events (single occurrences can be changed or
   removed), reminders, quick-add in plain words, due checklist items; synced like notes
   (`calendar.rs`, `/calendar/pull`); `.ics` import/export; today's agenda on Home. The Mac can show
   Apple Calendar and Reminders read-only (EventKit via JavaScript for Automation, one permission
   prompt), also on the paired PC (`/calendar/apple`, only when the Mac turns sharing on).
5. **Files over BridgeLink (built)**: files and folders go to paired computers on the encrypted
   QUIC link (`transfer.rs`, stream `/files/send`) with progress, speed, cancel and resume (partial
   files wait in app data; an interrupted send continues where it stopped, retrying itself on a
   dropped connection). Received files never overwrite ("name (1).ext"). The Files tab, tray,
   drag-and-drop, Send to / Open With and "Send my source" use it; LocalSend stays for other devices
   (and as the fallback for a paired computer on an older BridgeDeck).
6. **Mimir toolbox + memory (built)**: BridgeDeck starts Mimir with `BRIDGEDECK_API` and a token
   for `/mimir/…` on the loopback API (`bridgelink/mimir_api.rs`). Mimir's tools
   (`mimir/src/main/bridgedeck/`): search, read, create and append notes; add, tick and due-date
   checklist items; list, add and delete calendar events; read Messages and send them; paired
   computers' status and Wake-on-LAN; send files; clipboard; AI rooms. Sending a message or files
   shows a BridgeDeck dialog first. Long-term memory (MEMORY.md) is mirrored both ways with the
   "Mimir's memory" note, so it can be read and edited in Notes and on the other computer.
   Still to come: looking at or controlling the other computer from Mimir (with a banner and a
   confirm), moved to step 7.
7–9. Moved into Phase 9 below.

### Phase 9: Study, Projects, a vault, skills, and the rest of Phase 8 (planned 2026-10-01)
Everything left, combined into one order. One PR each.
1. **Vault (Obsidian-compatible notes) (built)**: every note is also a Markdown file in a vault folder on
   each computer (frontmatter keeps its id); edits made in Obsidian, Logseq or Zettlr come back
   into BridgeDeck and sync as usual. `[[links]]` with suggestions, backlinks, `#tags`, a graph
   view, and math (KaTeX).
2. **Study tab (built; EPUB opens in the system reader for now)**: courses with their textbooks (PDF via pdf.js, EPUB via epub.js), notes,
   checklists and exam dates; highlights become notes linked to the page; a book's table of
   contents becomes a chapter checklist with sub-tasks.
3. **Mimir study help (built; search is full-text BM25, embeddings later)**: answers from the user's books with book-and-page citations (local
   full-text and embedding search), summaries, practice quizzes, step-by-step explanations;
   flashcards from highlights or Mimir with FSRS scheduling (ts-fsrs); study sessions and exams on
   the calendar, a focus timer, progress per course and chapter.
4. **Projects tab (built)**: a synced folder, notes, a task board and milestones per project; Mimir works
   with the project's files and notes; merges with Mimir Projects.
5. **Skill library (built)**: Mimir loads skills in the SKILL.md format (instructions, references,
   stdlib-only scripts run in its sandbox), with skill packs chosen in Settings, starting with
   alirezarezvani/claude-skills (MIT; research, productivity, engineering, project management),
   downloaded at a pinned version.
5b. **ChatGPT side panel and a web reader for Mimir (built; asked for 2026-10-02; a side panel like a
   browser's assistant since 2026-10-02)**: chatgpt.com in a resizable panel at the side of BridgeDeck's
   window, opened from the tab bar, that the user uses themselves (signed in once), with "Send to ChatGPT" from Study and Projects
   (a passage, a note, a task) that fills the message box for the user to send; ChatGPT is a study and
   project helper, never the engine running the app. Mimir gets a browser for ordinary websites
   (search, read pages) for research. ChatGPT chats are kept with a "Save to BridgeDeck" button in the panel:
   each becomes a note in the course or project it was started from (else "ChatGPT"); saving again updates it.
5c. **Manga tab (built; from the user's manga-reader app, 2026-10-02)**: your own comics, manga and webtoons
   (.cbz/.zip or image folders) in the synced folder, with series details and covers from AniList, a
   scrolling or page-by-page (right-to-left) reader, bookmarks and shared progress, and the free
   Pepper&Carrot webcomic. Scanlation-site browsing and downloading from that app were left out.
5d. **TV tab (built; asked for 2026-10-03)**: streaming services (free: YouTube, Tubi, Pluto TV, the
   Roku Channel, PBS, Internet Archive films; with a subscription: Netflix, Prime Video, Disney+, Hulu,
   Max, Apple TV+, Paramount+, Peacock, Crunchyroll) and the user's own shortcuts, played in a web view
   inside the window like the Browser tab, with "Full window" and "Open in my browser" for services
   whose copy protection the built-in web view can't play.
6. **Mimir proactive + voice + safety (6a built: morning brief, evening study check-in, "while you were away", daily_brief for Mimir, activity log; 6b built look-only: Mimir sees a paired computer's screen with the user's yes and a banner there, and never clicks or types — chosen 2026-10-02)**: morning brief, deadline and exam nudges, "while you were
   away"; wake word and hotkey on both computers; self-written skills can use the BridgeDeck tools;
   an activity log, and a confirm for every outward action; looking at or controlling the other
   computer with a banner and a confirm.
7. **Instant Messages (built)**: the Mac watches `chat.db` and pushes new messages.
8. **Remote video and audio**: hardware H.264 (VideoToolbox / Media Foundation) decoded with
   WebCodecs, tiles as the fallback; audio via ScreenCaptureKit / WASAPI loopback.
9. **Extras (OCR built)**: lecture recording to notes (whisper.cpp, on device), OCR for scanned pages
   (Tesseract.js, bundled; pages pdf.js finds no text on are read by recognition while indexing),
   drawings in notes (Excalidraw).

Open-source parts (all permissive licences, so they can be built in): pdf.js, epub.js, KaTeX,
ts-fsrs, Excalidraw, Mermaid, Tesseract.js, whisper.cpp, SQLite FTS. Obsidian itself is not open
source, and Logseq / Joplin / SiYuan are AGPL apps, so they are supported through the vault
folder rather than built in.

### Phase 7: Mobile and extras
- **iPhone / iPad (D12)**: a BridgeDeck mobile build (Tauri 2 supports iOS) that pairs like any
  device and uses the capabilities iOS allows: remote-control viewer, Files (LocalSend protocol),
  clipboard, AI rooms, Messages viewer (served by the Mac), notifications. iOS cannot host remote
  control, run the Syncthing helper, or stay connected in the background, so those capabilities are
  simply not advertised.
- Wake-on-LAN button, audio in remote sessions, a SYSTEM service on Windows for UAC prompts, code
  signing and notarisation.
- **Built so far (free, no paid accounts)**:
  - Wake-on-LAN: paired computers report their hardware addresses in `/status`; a Wake button on
    Home and the Computers tab broadcasts the magic packet (same network only, not over Tailscale).
  - Remote: "ask me each time" can be set per device; Cmd+Option+Shift+S / Ctrl+Alt+Shift+S stops
    every session (registered only while one runs).
  - Free Mac signing: `npm run mac:signing` creates a self-signed "BridgeDeck Local Signing"
    certificate; updates sign with it so macOS keeps Screen Recording / Accessibility / Full Disk
    Access across rebuilds. Paid Apple signing and notarisation stay optional.
  - Updates of a copy started with `npm run tauri dev` only pull (and `npm install` when the lock
    file changed): the dev server rebuilds and restarts BridgeDeck itself. Previously the updater
    tried to replace the dev binary with an installed app.

Order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Rust tests for pairing, crypto and protocol code are
written together with Phase 1, not after it.

---

## Open questions

None at the moment. Answers from 2026-09-29 are recorded as D12–D15.

---

## Where things stand (2026-09-30)

**Phases 0–5 are built** (0.9.0, PR #5) and checked on Linux (Rust and frontend tests, including
pairing, the AI workspace, a remote session over real QUIC, and Syncthing started by the sidecar
code) and by cross-compiling for Windows. **None of it has run on the Mac or Windows hardware yet**,
and the macOS-only code (Messages sending, screen capture and input, the sidecar on macOS) has only
been compiled by CI's release build. Next: install on both computers (U), pair them again, go
through the checks below, then Phase 6.

| Area | State |
|---|---|
| App shell | Tab bar with fixed and closable tabs; features are modules; closes to tray |
| Pairing (BridgeLink v2) | QUIC with pinned certificates; six-digit code compared on both screens; LAN + Tailscale discovery; 0.8 pairings must pair again |
| Sync | Syncthing runs hidden inside BridgeDeck; an existing install can be moved in; conflicts tab |
| AI workspace | Agents, rooms, to-dos, file claims, addressed messages on every paired device; MCP server |
| Messages | Read and sent by BridgeDeck on the Mac (Full Disk Access + Automation); BlueBubbles removed |
| Remote | Built-in, in a tab, paired devices only, banner + Stop on the host; RustDesk removed (0.9.1) |
| Security | Audit HIGH #1/#2 and the MEDIUMs closed; loopback-only local API; CSP no longer allows LAN URLs |

### How the build differs from the plan (for review)

- **Identity key** (1.1) is kept in a user-only file (`identity-v2.json`, mode 0600), not the
  keychain: locally signed Mac builds look like a new app after every rebuild, and each would ask
  for Keychain access. Revisit with code signing (Phase 7).
- **AI workspace store** (Phase 3) is a JSON file (`ai-workspace.json`) and the message log a JSONL
  file, not SQLite: the data is small (capped at 200 rooms / 500 claims / 500 messages).
- **Messages "watcher"** (Phase 4) is the UI polling the new-message feed every 3 s (a cheap indexed
  query), rather than a file-system watcher on `chat.db`.
- **Remote video** (Phase 5) is changed-tile JPEG pulled by the viewer, not H.264 + WebCodecs: no
  platform encoder code or codec patents, and desktop content (mostly still) sends little. Full-screen
  video costs more bandwidth than H.264 would; the wire format allows swapping in H.264 later.
- **Remote options not built yet**: audio in sessions (clipboard is shared by clipboard sync; "ask
  first" per device and a stop shortcut came in Phase 7). RustDesk was removed in
  0.9.1 at the user's request (BridgeDeck must not depend on other apps); the Home tab quits RustDesk
  and BlueBubbles left over from older setups and stops them opening at login.

### Checks on real hardware (U)

1. Install 0.9 on both; pair again (codes match on both screens).
2. Sync tab: "Move into BridgeDeck" on each; `bridgedeck-shared` keeps syncing; uninstall the old app from login items.
3. Mac: give BridgeDeck Full Disk Access; Messages tab shows chats on both computers; send a text and a photo from Windows.
4. Remote: from Windows open the Mac in a tab (Mac asks for Screen Recording and Accessibility once); type, click, scroll; Stop from the Mac's banner. Then the other way round, and once over Tailscale away from home.
5. AI: `claude mcp add bridgedeck -- node agent/bridgedeck-mcp.mjs --agent claude-win` on Windows and the Mac equivalent; open a room, claim a file from one side, see it on the other.
