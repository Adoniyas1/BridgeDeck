import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fail = msg => { console.error(`FAIL ${msg}`); process.exitCode = 1 }
const ok = msg => console.log(`OK   ${msg}`)
const need = path => existsSync(join(root, path)) ? ok(path) : fail(`missing ${path}`)

for (const p of [
  'src/App.tsx', 'src/lib/bridge.ts', 'src/lib/config.ts', 'src/types.ts',
  'src-tauri/src/lib.rs', 'src-tauri/src/localsend_bridge.rs', 'src-tauri/src/bridgelink.rs', 'src-tauri/src/syncthing_bridge.rs',
  'src-tauri/capabilities/default.json', 'vendor-lock.json', 'docs/SYNCTHING_AUTO_SETUP.md',
]) need(p)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
if (pkg.version === '0.7.0') ok('package version 0.7.0'); else fail(`package version ${pkg.version}`)
if (tauri.version === '0.7.0') ok('Tauri version 0.7.0'); else fail(`Tauri version ${tauri.version}`)
if (pkg.dependencies?.['@tauri-apps/plugin-dialog']) ok('Tauri dialog dependency'); else fail('Tauri dialog dependency missing')

const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')
if (cargo.includes('path = "../vendor/localsend/packages/core"')) ok('native LocalSend path dependency'); else fail('native LocalSend path dependency missing')

const lib = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8')
const localSend = readFileSync(join(root, 'src-tauri/src/localsend_bridge.rs'), 'utf8')
const bridgeLink = readFileSync(join(root, 'src-tauri/src/bridgelink.rs'), 'utf8')
const sync = readFileSync(join(root, 'src-tauri/src/syncthing_bridge.rs'), 'utf8')
const rust = lib + localSend + bridgeLink + sync
for (const command of [
  'rustdesk_session', 'rustdesk_identity',
  'localsend_receiver_status', 'localsend_receiver_start', 'localsend_receiver_stop', 'localsend_accept', 'localsend_decline', 'localsend_send_native',
  'bridgelink_start', 'bridgelink_stop', 'bridgelink_status', 'bridgelink_request_pair', 'bridgelink_poll_pair', 'bridgelink_approve', 'bridgelink_decline', 'bridgelink_forget', 'bridgelink_refresh_peer',
  'syncthing_setup_peer',
]) rust.includes(command) ? ok(`native command ${command}`) : fail(`native command ${command} missing`)

for (const marker of [
  '239, 255, 77, 77', 'DISCOVERY_PORT: u16 = 41415', 'DEFAULT_API_PORT: u16 = 41416',
  'pairing_code()', 'Bearer token required', 'Access-Control-Allow-Origin', 'save_peers', 'syncthingDeviceId',
]) bridgeLink.includes(marker) ? ok(`BridgeLink guard ${marker}`) : fail(`BridgeLink guard missing: ${marker}`)

for (const marker of [
  '/rest/config/devices', '/rest/config/defaults/device', '/rest/config/folders', '/rest/config/defaults/folder',
  'Method::PATCH', 'BridgeDeck Shared', 'X-API-Key', 'fs::create_dir_all',
]) sync.includes(marker) ? ok(`Syncthing auto-setup ${marker}`) : fail(`Syncthing auto-setup missing: ${marker}`)

if (!rust.includes('command.arg("send").arg("--to")')) ok('obsolete LocalSend CLI send --to path removed'); else fail('obsolete LocalSend CLI send --to path still present')

const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
for (const text of [
  "page === 'remote'", "page === 'files'", "page === 'computers'", "page === 'sync'", 'pickTransferPaths', 'sendWithLocalSend',
  'Automatic Mac ↔ Windows pairing', 'requestAutomaticPair', 'approveAutomaticPair', 'applyPairedPeer',
  'configureSyncthingPeer', 'Setup sync', 'BridgeDeck Shared', 'syncthingDeviceId',
]) app.includes(text) ? ok(`UI integration ${text}`) : fail(`UI integration ${text} missing`)

const config = readFileSync(join(root, 'src/lib/config.ts'), 'utf8')
if (config.includes('configVersion: 7') && config.includes("sharedFolderId: 'bridgedeck-shared'") && config.includes('autoSetup: true')) ok('v0.7 sync config migration'); else fail('v0.7 sync config migration missing')
if (lib.includes('config-v7.json') && lib.includes('config-v6.json')) ok('native config v7 migration'); else fail('native config v7 migration missing')

const cap = JSON.parse(readFileSync(join(root, 'src-tauri/capabilities/default.json'), 'utf8'))
if (cap.permissions?.includes('dialog:allow-open')) ok('dialog open permission'); else fail('dialog open permission missing')

if (!process.exitCode) console.log('\nBridgeDeck v0.7 static project verification passed.')
