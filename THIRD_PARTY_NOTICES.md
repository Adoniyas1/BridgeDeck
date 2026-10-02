# Third-party source used by BridgeDeck

BridgeDeck is designed to vendor upstream open-source projects so their engines can be inspected and customized instead of treated as opaque external applications.

| Component | Pinned version | License | Intended use |
| --- | --- | --- | --- |
| Syncthing | 2.1.5 | MPL-2.0 | Continuous file synchronization |
| LocalSend | 1.18.2 | Apache-2.0 | Native local file-transfer core linked into BridgeDeck |

The authoritative upstream source, commit pin, repository URL, and platform scope live in `vendor-lock.json`.

When the source is fetched, the upstream license files remain inside each `vendor/<component>/` directory. Do not remove those notices when redistributing modified source or binaries.

## Tauri Dialog Plugin
BridgeDeck v0.7 uses `tauri-plugin-dialog` / `@tauri-apps/plugin-dialog` for native file and folder selection. The Tauri plugin is available under MIT OR Apache-2.0 terms. It is a package dependency rather than one of the large vendored application source trees.

## LocalSend core integration

BridgeDeck v0.7 links directly to the pinned Apache-2.0 LocalSend Rust core as a Cargo path dependency. Keep the upstream LocalSend license and notices with redistributed source/binaries as required by its license.

## KaTeX
The Notes tab renders `$math$` and `$$math$$` with KaTeX (`katex` on npm), MIT licence, © Khan Academy and other contributors. It is a package dependency; its licence ships inside `node_modules/katex`.

## PDF.js
The Study tab reads textbooks with PDF.js (`pdfjs-dist` on npm), Apache-2.0, © Mozilla and contributors. It is a package dependency; its licence ships inside `node_modules/pdfjs-dist`.
