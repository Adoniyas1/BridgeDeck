// Sets BridgeDeck's version everywhere it's read (used by the release workflow before building):
//   node scripts/set-version.mjs 0.9.2
import { readFileSync, writeFileSync } from 'node:fs'

const version = (process.argv[2] || '').replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Not a version: "${process.argv[2] ?? ''}" (expected like 0.9.2)`)
  process.exit(1)
}
const edit = (file, change) => writeFileSync(file, change(readFileSync(file, 'utf8')))
edit('package.json', text => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`))
edit('src-tauri/tauri.conf.json', text => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`))
edit('src-tauri/Cargo.toml', text => text.replace(/^version = "[^"]+"/m, `version = "${version}"`))
edit('src-tauri/Cargo.lock', text => text.replace(/(name = "bridgedeck"\nversion = ")[^"]+(")/, `$1${version}$2`))
console.log(`BridgeDeck version set to ${version}`)
