# BridgeDeck v0.7 bootstrap audit

Audit date: 2026-09-21

## Outcome

The React/TypeScript frontend is structurally complete, passes the project's static verifier, builds successfully, and renders correctly in browser-mode smoke tests. The archive is a bootstrap rather than a complete native source bundle: all six vendored upstream projects and the Windows Rust/Cargo toolchain are absent, so a native Tauri executable cannot yet be compiled or tested.

## Verification performed

- `node scripts/verify-project.mjs`: PASS
- `pnpm run build`: PASS
- Production Vite output generated in `dist/`
- Dependency audit: no known production dependency vulnerabilities
- Browser smoke test: Home, Files, Sync, and Settings rendered and navigated successfully
- `node scripts/vendor.mjs verify`: expected FAIL because all vendored projects are absent
- `node scripts/verify-localsend-core.mjs`: expected FAIL because LocalSend core is absent
- Native Rust build: not run because Cargo/Rust and the LocalSend path dependency are absent

## Findings

### High — Windows URL opening uses `cmd /C start`

`src-tauri/src/lib.rs` validates only an `http://` or `https://` prefix, then passes the value through `cmd /C start`. Command-shell metacharacters in a configured URL may be interpreted by `cmd.exe`. Replace this with a shell-free Windows URL launcher or strictly parse and validate the URL before invoking the OS.

### High — BridgeLink pairing exchanges long-lived tokens over plaintext HTTP

The bootstrap explicitly documents that initial pairing is not TLS encrypted. Pair requests include issued bearer tokens and are sent over the LAN using the custom plaintext HTTP client. This is acceptable only on a trusted network and should be replaced with authenticated TLS or an ephemeral-key handshake before broader distribution.

### Medium — Secrets are duplicated into WebView localStorage and plaintext config

BlueBubbles passwords, Matrix tokens, Syncthing API keys, machine bearer tokens, and LocalSend PINs are stored in the serialized application config. The frontend always writes this full config to localStorage and the native backend writes plaintext JSON. Unix permissions are reduced to `0600`, but Windows does not receive an explicit secret-store treatment. Use the operating-system credential vault and keep secrets out of localStorage.

### Medium — BridgeLink uses wildcard CORS

The LAN API responds with `Access-Control-Allow-Origin: *`, including pairing routes. Authentication protects status data, but arbitrary websites can still reach the pairing surface and generate requests. Restrict origins to the Tauri application and required local development origins.

### Medium — Syncthing API credentials can be sent to an arbitrary configured URL

The URL validator accepts any HTTP or HTTPS host. Because the local API key is attached as `X-API-Key`, a mistaken or malicious configuration can transmit the key to a remote host. Default-deny non-loopback Syncthing URLs or require an explicit high-visibility confirmation.

### Medium — Bootstrap was not reproducible until this audit generated a lockfile

The archive contained version ranges but no npm/pnpm lockfile. This audit generated `pnpm-lock.yaml` and `pnpm-workspace.yaml`; keep both in future packages so dependency versions and approved native build scripts are deterministic.

### Low — Documentation version mismatch

`docs/SECURITY.md` still calls itself v0.6 although the project is v0.7.

## Generated audit artifacts

- `pnpm-lock.yaml`
- `pnpm-workspace.yaml` allowing only the expected `esbuild` install script
- `node_modules/`
- `dist/`

## Required before a native release

1. Fetch or restore the pinned vendor tree and verify every commit.
2. Install a trusted Rust/Cargo toolchain and Windows Tauri prerequisites.
3. Fix the two high-severity findings.
4. Run `verify:project`, `vendor:verify`, `verify:localsend-core`, `cargo check`, and `tauri build`.
5. Repeat native build and end-to-end pairing, transfer, and Syncthing tests on macOS.
