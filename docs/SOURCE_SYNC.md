# Working on BridgeDeck from GitHub

The GitHub repository [`Adoniyas1/BridgeDeck`](https://github.com/Adoniyas1/BridgeDeck) is the source
of truth for BridgeDeck's code (roadmap D10). Each computer works in its own clone and builds its own
app. The old `bridgedeck-source` Syncthing folder is retired: two computers editing the same files
through Syncthing produced `*.sync-conflict-*` copies, and Syncthing must never touch a `.git` folder.

## Setting up a computer

```bash
git clone https://github.com/Adoniyas1/BridgeDeck.git
cd BridgeDeck
npm install
npm run vendor:fetch            # or: node scripts/reuse-vendor.mjs <old BridgeDeck folder>
npm run verify:project
npm run tauri dev               # or: npm run tauri build
```

Only LocalSend's source is needed to build (`node scripts/vendor.mjs fetch --only localsend`); the other
pinned trees are for reference and for building standalone runtimes.

## Retiring the `bridgedeck-source` Syncthing folder

On both computers, in Syncthing: open the `bridgedeck-source` folder → **Edit** → **Remove**. This stops
syncing and keeps the files. Then start from a fresh clone as above. `.stignore` now also ignores `.git`
in case the folder stays shared for a while.

The `bridgedeck-shared` folder (`~/BridgeDeck Shared`) is unaffected: it is the workspace BridgeDeck
itself syncs between the computers.

## Getting installers

- **From CI**: GitHub → **Actions** → **Release build** → **Run workflow**. When it finishes, download the
  `bridgedeck-macos-latest` (DMG) and `bridgedeck-windows-latest` (NSIS/MSI) artifacts. Pushing a tag like
  `v0.8.0` also creates a draft release with them.
- **Locally**: `npm run tauri build` on each computer.

Every pull request runs the cheap checks in `.github/workflows/ci.yml` (frontend build and tests, the
static verifier, and Rust checks for Linux and Windows). Installers are built only on demand (D13).

## Working rules for people and AI assistants

- Start from an up-to-date `main` (`git pull`), work on a branch, and open a pull request. Don't push to
  `main` directly and never force-push someone else's branch.
- One branch per task. Before editing, say on the AI relay which branch and files you're taking
  (`--channel planning`), so two assistants don't change the same files at once.
- Build and install only on your own computer.
- Keep `docs/ROADMAP.md` current: it is the plan both computers build toward.
