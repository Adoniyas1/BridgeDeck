import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parent = dirname(root)
const folder = basename(root)
const lock = JSON.parse(readFileSync(join(root, 'vendor-lock.json'), 'utf8'))
for (const component of lock.components) {
  if (!existsSync(join(root, 'vendor', component.id, '.bridgedeck-vendor.json'))) {
    throw new Error(`Missing vendored source: ${component.id}. Run npm run vendor:fetch or vendor:reuse first.`)
  }
}
const out = join(parent, 'BridgeDeck-v0.7-vendored-source.zip')
try {
  execFileSync('zip', ['-qr', out, folder, '-x', `${folder}/node_modules/*`, `${folder}/dist/*`, `${folder}/src-tauri/target/*`, `${folder}/.vendor-tmp/*`], { cwd: parent, stdio: 'inherit' })
  console.log(out)
} catch {
  throw new Error('Could not run zip. Install a zip utility or archive the folder manually after vendor:verify passes.')
}
