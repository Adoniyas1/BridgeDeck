import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parent = dirname(root)
const folder = basename(root)
const out = join(parent, 'BridgeDeck-v0.7-auto-sync-bootstrap.zip')
const excluded = [
  `${folder}/node_modules/*`, `${folder}/dist/*`, `${folder}/src-tauri/target/*`,
  `${folder}/vendor/syncthing/*`, `${folder}/vendor/localsend/*`,
  `${folder}/.vendor-tmp/*`,
]
execFileSync('zip', ['-qr', out, folder, '-x', ...excluded], { cwd: parent, stdio: 'inherit' })
console.log(out)
