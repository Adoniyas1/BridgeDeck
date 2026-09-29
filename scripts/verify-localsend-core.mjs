import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expected = [
  'vendor/localsend/packages/core/Cargo.toml',
  'vendor/localsend/packages/core/src/lib.rs',
  'vendor/localsend/packages/core/src/http/server/mod.rs',
  'vendor/localsend/packages/core/src/http/client/v2.rs',
  'vendor/localsend/.bridgedeck-vendor.json',
]
let failed = false
for (const rel of expected) {
  if (existsSync(join(root, rel))) console.log(`OK   ${rel}`)
  else { console.error(`FAIL missing ${rel}`); failed = true }
}
if (!failed) {
  const marker = JSON.parse(readFileSync(join(root, 'vendor/localsend/.bridgedeck-vendor.json'), 'utf8'))
  if (marker.commit === 'af0416be50770a97760f7070684bc667b759a15c') console.log('OK   pinned LocalSend v1.18.2 commit')
  else { console.error(`FAIL unexpected LocalSend commit ${marker.commit || 'unknown'}`); failed = true }
}
if (failed) process.exit(1)
console.log('\nLocalSend core source is ready for BridgeDeck native builds.')
