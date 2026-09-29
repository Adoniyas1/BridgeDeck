# BridgeDeck roadmap

Goal: the Mac and the Windows PC behave like one workspace. Files, clipboard, screen control, messages and the
two AI assistants work without setup steps, and the connection is safe enough to leave on all the time.

Owners: **W** = Claude on Windows, **M** = Claude on the Mac, **U** = the user (permissions, passwords, approvals).
Code is written on either side and reaches the other through the `bridgedeck-source` Syncthing folder
(rules in `SOURCE_SYNC.md`). Every phase ends with both computers rebuilt and the phase's checks passing.

---

## Where things stand (2026-09-25)

| Area | State |
|---|---|
| Pairing (BridgeLink) | Works; peer status shown natively; IP changes followed automatically |
| AI relay | Works both ways, long messages OK; agents poll every 2 s |
| Syncthing | `bridgedeck-shared` and `bridgedeck-source` in sync; Windows auto-start still off |
| File transfer | Receiver auto-starts; paired computer auto-accepted; drag-and-drop to queue |
| RustDesk | Auto-detected and kept running; Mac still needs permissions + Direct IP; connect not yet confirmed |
| BlueBubbles | Not installed |
| Security | Audit highs still open: plaintext pairing tokens, `cmd /C start` URL opening |
| Engineering | No version control; `App.tsx` is one ~60 KB file; no automated tests |

---

## Phase 0: Finish and stabilise (now, small)

| # | Task | Owner | Done when |
|---|---|---|---|
| 0.1 | RustDesk on the Mac: Screen Recording, Accessibility, Input Monitoring; Direct IP on; permanent password. Direct IP on for Windows too | U, M | Control works both directions, and the notice says "via direct LAN" |
| 0.2 | Turn on Syncthing Auto-start in BridgeDeck on Windows | U | Syncthing is running after a reboot |
| 0.3 | Launch BridgeDeck at login on both (Tauri autostart plugin, toggle in Settings, default on) | W | After a reboot both cards show Online with nobody touching anything |
| 0.4 | Put source under git (Windows is the history of record); add `.git` to `.stignore` on both | W, M | Each phase is a commit; Syncthing never touches `.git` |
| 0.6 | Outbound BridgeLink connections get a connect timeout; the relay reports "peer offline" instead of stalling past the client's 10 s limit | W | Sending while the Mac sleeps fails fast with a clear error |
| 0.5 | Bump to 0.8.0; show the build version on both cards, with a warning when they differ | W | Mismatched builds are obvious on Home |

## Phase 1: Security hardening (before anything that widens exposure)

These close the audit's open findings. They matter more once clipboard sync (Phase 2) or remote access
(Phase 5) is added.

| # | Task | Why |
|---|---|---|
| 1.1 | Replace `cmd /C start` with a shell-free opener (`tauri-plugin-opener`) | Audit HIGH: a crafted URL could run commands |
| 1.2 | Authenticated pairing: X25519 key exchange, with the six-digit code **derived from the shared key** so both screens show the same code only when nobody is in the middle | Audit HIGH: tokens currently cross the LAN in plaintext and the code only prevents picking the wrong computer |
| 1.3 | Encrypt all BridgeLink traffic (status, relay, future clipboard) with the pairing key (ChaCha20-Poly1305) | Relay messages and tokens are readable by anyone on the Wi-Fi today |
| 1.4 | Secrets to the OS keychain (`keyring` crate: Windows Credential Manager / macOS Keychain); stop writing them to localStorage | Audit MEDIUM: API keys, tokens, passwords in plaintext JSON |
| 1.5 | CORS: allow only the Tauri origin | Audit MEDIUM: any website can reach the pairing API |
| 1.6 | Syncthing/BlueBubbles URLs loopback- or LAN-only unless explicitly confirmed | Audit MEDIUM: API keys could be sent to an arbitrary host |
| 1.7 | Re-pair once after 1.2/1.3 ship (old tokens rejected) | U |

## Phase 2: Everyday experience

| # | Task | Notes |
|---|---|---|
| 2.1 | **Clipboard sync** (text and images), paired computer only, toggle in Settings, off by default until 1.3 ships | The biggest daily win; needs encryption first |
| 2.2 | **"Send to Mac/Windows" from the OS**: Explorer *Send to* shortcut on Windows; Finder Quick Action on the Mac | No need to open BridgeDeck to send a file |
| 2.3 | Tray (Windows) / menu-bar (Mac) icon: status dot, Send files, Control other computer, Open shared folder | BridgeDeck can live in the background |
| 2.4 | Native notifications: file received, relay message for the human, peer went offline, rebuild needed | |
| 2.5 | Home becomes a health checklist with fix-it buttons (RustDesk permission missing, Syncthing stopped, builds differ, peer offline) | One place to see what's wrong |
| 2.6 | Receive folder defaults to `~/BridgeDeck Shared/Inbox` so received files also land on the other side's shared folder | Optional: user decision |

## Phase 3: BlueBubbles (iMessage on Windows)

| # | Task | Owner |
|---|---|---|
| 3.1 | Install BlueBubbles Server 1.9.9 on the Mac; grant Full Disk Access + Accessibility; set password; LAN-only URL `http://192.168.4.28:1234` | M, U |
| 3.2 | BridgeLink shares the BlueBubbles URL (never the password); user enters the password once on Windows (stored in keychain after 1.4) | W |
| 3.3 | Messages page on Windows: chat list, send, new-message notifications | W |
| 3.4 | BlueBubbles Server kept running by BridgeDeck on the Mac (same pattern as RustDesk) | W |

## Phase 4: AI collaboration

| # | Task | Why |
|---|---|---|
| 4.1 | **MCP server** (`agent/bridgedeck-mcp`) exposing relay send/read/wait, peer status, sync status, rebuild status as tools | Claude and Codex use BridgeDeck natively instead of shell commands |
| 4.2 | Long-poll endpoint (`/ai/wait`) instead of 2 s polling; notification in BridgeDeck when a message is for the human | Instant delivery, no busy loop |
| 4.3 | File claims: `/ai/claim` + `/ai/release`; BridgeDeck shows who is editing what; MCP refuses to edit claimed files | Enforces the source-sync rules instead of relying on memory |
| 4.4 | One-command rebuild + install per platform (`scripts/rebuild-install.ps1`, `.sh`), with results posted to the relay | Less manual work, fewer mistakes |
| 4.5 | Shared task board (`#tasks` channel, or `tasks.json` in the shared folder) shown in the AI Center | Both agents and the user see the same to-do list |

## Phase 5: Engineering quality

| # | Task |
|---|---|
| 5.1 | Split `App.tsx` into per-page components and hooks; no behaviour change |
| 5.2 | Rust unit tests: relay auth, trusted-host auto-accept, peer IP update, `myID` serialisation, multi-packet HTTP reads |
| 5.3 | `scripts/smoke-test.mjs`: after a rebuild, check `/status`, relay loopback, Syncthing folder state, receiver running |
| 5.4 | Remove the dead Matrix-only paths or keep Matrix behind a clear "optional" switch |

## Phase 6: Optional extensions (user decisions)

- **Away from home**: Tailscale on both computers; BridgeLink over the tailnet. Only after Phase 1.
- **Wake the Mac**: enable "Wake for network access" on the Mac; Wake-on-LAN button on the Mac card.
- **iPhone**: BlueBubbles or LocalSend on iOS to join the same network of devices.

---

## Suggested order

Phase 0 → Phase 1 → Phase 3 (BlueBubbles, already requested) → Phase 2 → Phase 4 → Phase 5 → Phase 6.
Phase 5.2 tests are written alongside Phase 1, since security code needs them most.
