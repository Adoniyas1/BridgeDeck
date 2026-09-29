# BridgeDeck on Windows

## Requirements

- Node.js 22 and npm
- Rust (`rustup`, stable, MSVC toolchain)
- Microsoft C++ Build Tools and WebView2

## Build and run

```powershell
git clone https://github.com/Adoniyas1/BridgeDeck.git
cd BridgeDeck
npm install
npm run vendor:fetch
npm run verify:project
npm run tauri dev        # or build the installer:
npm run tauri build      # → src-tauri\target\release\bundle\nsis\ (or msi\)
```

If `rustc` crashes while optimizing LocalSend code, retry with
`CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_OPT_LEVEL=2 CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`.

A prebuilt installer is available from GitHub Actions: **Actions → Release build → Run workflow**.

See `docs/SOURCE_SYNC.md` for how the two computers share work, and `docs/SECURITY.md` before pairing.
