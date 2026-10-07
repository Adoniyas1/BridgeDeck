import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fail = msg => { console.error(`FAIL ${msg}`); process.exitCode = 1 }
const ok = msg => console.log(`OK   ${msg}`)
const need = path => existsSync(join(root, path)) ? ok(path) : fail(`missing ${path}`)

for (const p of [
  'src/shell/App.tsx', 'src/shell/TabBar.tsx', 'src/core/tabs.ts', 'src/features/registry.ts', 'src/lib/bridge.ts', 'src/lib/config.ts', 'src/types.ts',
  'src-tauri/src/lib.rs', 'src-tauri/src/localsend_bridge.rs', 'src-tauri/src/bridgelink/mod.rs', 'src-tauri/src/bridgelink/peer.rs', 'src-tauri/src/link/transport.rs', 'src-tauri/src/syncthing_bridge.rs',
  'src-tauri/capabilities/default.json', 'vendor-lock.json', 'docs/SYNCTHING_AUTO_SETUP.md',
]) need(p)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const cargoVersion = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)?.[1]
if (pkg.version === tauri.version && pkg.version === cargoVersion) ok(`version ${pkg.version} in package.json, tauri.conf.json and Cargo.toml`)
else fail(`versions differ: package.json ${pkg.version}, tauri.conf.json ${tauri.version}, Cargo.toml ${cargoVersion}`)
if (pkg.dependencies?.['@tauri-apps/plugin-dialog']) ok('Tauri dialog dependency'); else fail('Tauri dialog dependency missing')

// `tauri build` refuses to run when the Rust crate and the npm packages are on different minor
// releases (a new Rust plugin can pull a newer tauri crate into Cargo.lock).
const lockedVersion = (text, name) => text.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))?.[1]
const minor = version => version?.split('.').slice(0, 2).join('.')
const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8')
const npmLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const tauriCrate = lockedVersion(cargoLock, 'tauri')
for (const name of ['@tauri-apps/api', '@tauri-apps/cli']) {
  const npmVersion = npmLock.packages?.[`node_modules/${name}`]?.version
  if (minor(npmVersion) === minor(tauriCrate)) ok(`${name} ${npmVersion} matches the tauri crate ${tauriCrate}`)
  else fail(`${name} is ${npmVersion} but Cargo.lock has tauri ${tauriCrate}: put them on the same minor release (npm install ${name}@^${minor(tauriCrate)}.0)`)
}

const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')
if (cargo.includes('path = "../vendor/localsend/packages/core"')) ok('native LocalSend path dependency'); else fail('native LocalSend path dependency missing')

const lib = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8')
const localSend = readFileSync(join(root, 'src-tauri/src/localsend_bridge.rs'), 'utf8')
const bridgeLink = ['mod.rs', 'peer.rs', 'discovery.rs', 'local.rs'].map(f => readFileSync(join(root, 'src-tauri/src/bridgelink', f), 'utf8')).join('\n')
  + readFileSync(join(root, 'src-tauri/src/link/sas.rs'), 'utf8') + readFileSync(join(root, 'src-tauri/src/link/tls.rs'), 'utf8')
const sync = readFileSync(join(root, 'src-tauri/src/syncthing_bridge.rs'), 'utf8')
const rust = lib + localSend + bridgeLink + sync
for (const command of [
  'legacy_apps', 'legacy_apps_stop',
  'localsend_receiver_status', 'localsend_receiver_start', 'localsend_receiver_stop', 'localsend_accept', 'localsend_decline', 'localsend_send_native',
  'bridgelink_start', 'bridgelink_stop', 'bridgelink_status', 'bridgelink_request_pair', 'bridgelink_poll_pair', 'bridgelink_approve', 'bridgelink_decline', 'bridgelink_forget', 'bridgelink_refresh_peer', 'bridgelink_confirm_pair', 'bridgelink_peer_status',
  'syncthing_setup_peer',
]) rust.includes(command) ? ok(`native command ${command}`) : fail(`native command ${command} missing`)

for (const marker of [
  '239, 255, 77, 77', 'DISCOVERY_PORT: u16 = 41415', 'DEFAULT_API_PORT: u16 = 41416',
  // v2: pinned certificates, committed pairing codes, loopback-only HTTP with an Origin allowlist.
  'sas::commitment', 'fn peer_fingerprint', 'This device is not paired', 'fn origin_allowed', 'TcpListener::bind(("127.0.0.1"',
  'save_peers', 'syncthingDeviceId',
]) bridgeLink.includes(marker) ? ok(`BridgeLink guard ${marker}`) : fail(`BridgeLink guard missing: ${marker}`)

for (const marker of [
  '/rest/config/devices', '/rest/config/defaults/device', '/rest/config/folders', '/rest/config/defaults/folder',
  'Method::PATCH', 'BridgeDeck Shared', 'X-API-Key', 'fs::create_dir_all',
]) sync.includes(marker) ? ok(`Syncthing auto-setup ${marker}`) : fail(`Syncthing auto-setup missing: ${marker}`)

// Phase 3: the AI workspace; Phase 4: Messages read on the Mac, BlueBubbles gone.
const workspace = readFileSync(join(root, 'src-tauri/src/bridgelink/workspace.rs'), 'utf8')
const imessage = ['mod.rs', 'chatdb.rs', 'typedstream.rs', 'contacts.rs'].map(f => readFileSync(join(root, 'src-tauri/src/imessage', f), 'utf8')).join('\n')
for (const marker of ['fn merge(', 'fn claim(', 'fn is_for(', 'pub fn ai_workspace']) workspace.includes(marker) ? ok(`AI workspace ${marker}`) : fail(`AI workspace missing: ${marker}`)
for (const marker of ['SQLITE_OPEN_READ_ONLY', 'fn text(data: &[u8])', 'Full Disk Access', '.args([chat, kind, payload])', 'Library/Messages']) imessage.includes(marker) ? ok(`Messages engine ${marker}`) : fail(`Messages engine missing: ${marker}`)
if (!/bluebubbles|rustdesk_|launch_app|managed_service/i.test(lib + bridgeLink)) ok('No external apps launched (RustDesk, BlueBubbles, service manager removed)'); else fail('Code that launches external apps is still present')
// Phase 5: remote control in tabs, paired devices only, with a stop banner.
const remote = ['mod.rs', 'host.rs', 'viewer.rs', 'codec.rs', 'input.rs', 'platform.rs'].map(f => readFileSync(join(root, 'src-tauri/src/remote', f), 'utf8')).join('\n')
for (const marker of ['pub async fn serve(', 'fn stop_all()', 'ask_first', 'fn encode(', 'Coordinate::Abs', 'SESSION_PATH']) remote.includes(marker) ? ok(`Remote control ${marker}`) : fail(`Remote control missing: ${marker}`)
bridgeLink.includes('This device is not paired with this computer".into() }') ? ok('Remote sessions only for paired devices') : fail('Remote session pairing check missing')
existsSync(join(root, 'agent/bridgedeck-mcp.mjs')) ? ok('MCP server present') : fail('agent/bridgedeck-mcp.mjs missing')

if (!rust.includes('command.arg("send").arg("--to")')) ok('obsolete LocalSend CLI send --to path removed'); else fail('obsolete LocalSend CLI send --to path still present')

// The UI is split into src/shell, src/core and src/features/<id>; check the markers across all of it.
const sourceFiles = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : [])
const app = sourceFiles('src').map(file => readFileSync(join(root, file), 'utf8')).join('\n')
const registry = readFileSync(join(root, 'src/features/registry.ts'), 'utf8')
for (const feature of ['home', 'devices', 'remote', 'messages', 'ai', 'files', 'sync']) {
  registry.includes(`import { ${feature} } from './${feature}'`) ? ok(`feature registered: ${feature}`) : fail(`feature not registered: ${feature}`)
}
for (const text of [
  'pickTransferPaths', 'sendToPeer', 'transferSend',
  'Automatic pairing', 'requestAutomaticPair', 'approveAutomaticPair', 'applyPairedPeer',
  'configureSyncthingPeer', 'Setup sync', 'BridgeDeck Shared', 'syncthingDeviceId', 'openTab', 'closeTab',
  'remote-session', 'remote-banner', 'ai-room',
]) app.includes(text) ? ok(`UI integration ${text}`) : fail(`UI integration ${text} missing`)

const config = readFileSync(join(root, 'src/lib/config.ts'), 'utf8')
if (config.includes('configVersion: 8') && config.includes('migrateMachines') && config.includes("sharedFolderId: 'bridgedeck-shared'") && config.includes('autoSetup: true')) ok('v0.8 device-list config migration'); else fail('v0.8 device-list config migration missing')
if (lib.includes('config-v7.json') && lib.includes('config-v6.json')) ok('native config v7 migration'); else fail('native config v7 migration missing')

const cap = JSON.parse(readFileSync(join(root, 'src-tauri/capabilities/default.json'), 'utf8'))
if (cap.permissions?.includes('dialog:allow-open')) ok('dialog open permission'); else fail('dialog open permission missing')

// macOS and Windows don't tell "Assignments" from "assignments": two modules in one folder whose
// names differ only in case (or only in extension) make an import resolve to the wrong one there,
// though Linux (CI) builds fine. Every module name in a folder must be unique ignoring case.
const moduleDirs = dir => readdirSync(join(root, dir), { withFileTypes: true }).filter(e => e.isDirectory() && !['node_modules', 'dist', 'target', 'public'].includes(e.name)).flatMap(e => moduleDirs(join(dir, e.name))).concat([dir])
let caseClashes = 0
for (const dir of ['src', 'mimir/src', 'agent'].filter(d => existsSync(join(root, d))).flatMap(moduleDirs)) {
  const seen = new Map()
  for (const name of readdirSync(join(root, dir)).filter(n => /\.(tsx?|jsx?|mjs|cjs|css)$/.test(n))) {
    const key = name.replace(/\.(test\.)?(tsx?|jsx?|mjs|cjs|css)$/, m => m.startsWith('.test.') ? '.test' : '').toLowerCase()
    const other = seen.get(key)
    if (other) { caseClashes++; fail(`${dir}: ${other} and ${name} clash on macOS and Windows (names differ only in case or extension)`) }
    seen.set(key, name)
  }
}
if (!caseClashes) ok('no module names that clash on case-insensitive disks')

if (!process.exitCode) console.log(`\nBridgeDeck ${pkg.version} static project verification passed.`)
