// Builds the pinned Syncthing (vendor/syncthing) into runtime/<platform>/syncthing/, where BridgeDeck
// bundles and runs it as a hidden helper (src-tauri/src/sync_sidecar.rs).
//
//   node scripts/build-syncthing.mjs                 this computer's platform
//   node scripts/build-syncthing.mjs --platform windows
//   node scripts/build-syncthing.mjs --platform macos --universal   (arm64 + x86_64 via lipo)
//
// Needs Go (it downloads the toolchain version Syncthing asks for) and `npm run vendor:fetch` (or
// `node scripts/vendor.mjs fetch --only syncthing`) first.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'vendor', 'syncthing')
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const hostPlatform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
const platform = arg('--platform') || hostPlatform
const universal = process.argv.includes('--universal')
const goos = { macos: 'darwin', windows: 'windows', linux: 'linux' }[platform]
if (!goos) throw new Error(`Unknown platform ${platform}`)
if (!existsSync(join(source, 'build.go'))) throw new Error('vendor/syncthing is missing: run node scripts/vendor.mjs fetch --only syncthing')

const lock = JSON.parse(readFileSync(join(root, 'vendor-lock.json'), 'utf8'))
const version = lock.components.find(c => c.id === 'syncthing').ref
const exe = goos === 'windows' ? 'syncthing.exe' : 'syncthing'
const outDir = join(root, 'runtime', platform, 'syncthing')
mkdirSync(outDir, { recursive: true })

function build(goarch) {
  console.log(`Building Syncthing ${version} for ${goos}/${goarch}…`)
  rmSync(join(source, exe), { force: true })
  execFileSync('go', ['run', 'build.go', '-no-upgrade', '-version', version, '-goos', goos, '-goarch', goarch, 'build', 'syncthing'], {
    cwd: source, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' },
  })
  const built = join(source, exe)
  const target = join(outDir, universal ? `${exe}-${goarch}` : exe)
  copyFileSync(built, target)
  return target
}

if (universal) {
  if (goos !== 'darwin') throw new Error('--universal is for macOS')
  const parts = ['arm64', 'amd64'].map(build)
  execFileSync('lipo', ['-create', '-output', join(outDir, exe), ...parts], { stdio: 'inherit' })
  parts.forEach(p => rmSync(p, { force: true }))
} else {
  const goarch = arg('--arch') || { x64: 'amd64', arm64: 'arm64' }[process.arch] || 'amd64'
  build(goarch)
}
if (goos !== 'windows') chmodSync(join(outDir, exe), 0o755)
console.log(`Syncthing ready: ${join(outDir, exe)}`)
