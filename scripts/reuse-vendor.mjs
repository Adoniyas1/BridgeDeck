import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(process.argv[2] || '')
const lock = JSON.parse(readFileSync(join(root, 'vendor-lock.json'), 'utf8'))

if (!process.argv[2] || !existsSync(sourceRoot)) {
  console.error('Usage: node scripts/reuse-vendor.mjs /path/to/previous/bridgedeck')
  process.exit(2)
}

mkdirSync(join(root, 'vendor'), { recursive: true })
let failed = 0
for (const component of lock.components) {
  const src = join(sourceRoot, 'vendor', component.id)
  const metaPath = join(src, '.bridgedeck-vendor.json')
  if (!existsSync(src) || !existsSync(metaPath)) {
    console.error(`MISS ${component.id}: not present in ${sourceRoot}`)
    failed += 1
    continue
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  if (meta.repo !== component.repo || meta.ref !== component.ref || !String(meta.commit || '').startsWith(component.commitPrefix)) {
    console.error(`FAIL ${component.id}: previous source does not match the v0.3 pin`)
    failed += 1
    continue
  }
  const dest = join(root, 'vendor', component.id)
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  console.log(`OK   reused ${component.id} @ ${meta.commit}`)
}

if (failed) process.exitCode = 1
