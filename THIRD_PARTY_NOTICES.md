# Third-party source used by BridgeDeck

BridgeDeck is designed to vendor upstream open-source projects so their engines can be inspected and customized instead of treated as opaque external applications.

| Component | Pinned version | License | Intended use |
| --- | --- | --- | --- |
| RustDesk | 1.4.9 | AGPL-3.0 | Remote desktop/control |
| Syncthing | 2.1.5 | MPL-2.0 | Continuous file synchronization |
| LocalSend | 1.18.2 | Apache-2.0 | Native local file-transfer core linked into BridgeDeck |
| BlueBubbles Client | 2.1.1+91 | Apache-2.0 | iMessage client source |
| BlueBubbles Server | 1.9.9 | Apache-2.0 | Mac-side iMessage bridge |

The authoritative upstream source, commit pin, repository URL, and platform scope live in `vendor-lock.json`.

When the source is fetched, the upstream license files remain inside each `vendor/<component>/` directory. Do not remove those notices when redistributing modified source or binaries. RustDesk's AGPL obligations are especially important when distributing modified RustDesk-derived builds.

## Tauri Dialog Plugin
BridgeDeck v0.7 uses `tauri-plugin-dialog` / `@tauri-apps/plugin-dialog` for native file and folder selection. The Tauri plugin is available under MIT OR Apache-2.0 terms. It is a package dependency rather than one of the large vendored application source trees.

## LocalSend core integration

BridgeDeck v0.7 links directly to the pinned Apache-2.0 LocalSend Rust core as a Cargo path dependency. Keep the upstream LocalSend license and notices with redistributed source/binaries as required by its license.
