# BridgeDeck v0.7 setup

## 1. Restore the vendored source

Reuse a previously verified BridgeDeck vendor tree:

```bash
./scripts/upgrade-from-previous.sh ../bridgedeck-v0.5
```

Or fetch directly:

```bash
npm run vendor:fetch
npm run vendor:verify
npm run verify:localsend-core
```

## 2. Install frontend/Tauri dependencies

```bash
npm install
```

## 3. Verify

```bash
npm run verify:project
npm run vendor:verify
npm run verify:localsend-core
```

## 4. Start native desktop mode

```bash
npm run tauri dev
```

Run BridgeDeck v0.7 on both the Mac and Windows computer.

## 5. Pair the computers automatically

On both machines, open **Computers**. BridgeLink starts automatically by default.

When the other machine appears:

1. click **Pair**;
2. compare the six-digit code on both computers;
3. approve the incoming request on the other computer;
4. wait for BridgeDeck to complete the pairing automatically.

The matching Mac/Windows slot is populated with the peer's BridgeLink status URL/token, RustDesk ID and LocalSend target.

If discovery is blocked, check the local firewall for UDP `41415` and TCP `41416`.

## 6. Configure local file receiving

In **Settings → Native LocalSend**, set an alias and optionally a receive folder, port, and receive PIN. Leave auto-accept off until you explicitly want unattended incoming file acceptance.

## 7. Other services

- BlueBubbles: Mac server URL + password.
- Syncthing: REST base URL + API key.
- RustDesk: bundled/custom runtime or installed RustDesk application.

The legacy standalone Bridge Agent is optional after BridgeLink pairing.
