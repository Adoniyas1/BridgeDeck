# BridgeDeck on the Mac

## Requirements

- macOS 13 or newer
- Xcode Command Line Tools (`xcode-select --install`)
- Node.js 22 and npm
- Rust (`rustup`, stable)

## Build and run

```bash
git clone https://github.com/Adoniyas1/BridgeDeck.git
cd BridgeDeck
npm install
npm run vendor:fetch
npm run verify:project
npm run tauri dev        # or build the app:
npm run tauri build      # → src-tauri/target/release/bundle/macos/BridgeDeck.app
```

Copy the built app to `/Applications` and open it (it is unsigned: right-click → **Open** the first
time). When macOS asks, allow incoming connections and Local Network access, and choose **Always Allow**
when BridgeDeck asks for its Keychain entry.

A prebuilt DMG is available from GitHub Actions: **Actions → Release build → Run workflow**.

See `docs/SOURCE_SYNC.md` for how the two computers share work, and `docs/SECURITY.md` before pairing.
