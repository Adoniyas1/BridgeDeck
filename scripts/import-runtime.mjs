import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import process from 'node:process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const service = process.argv[2]
const source = process.argv[3] ? resolve(process.argv[3]) : ''
const allowed = ['syncthing']
if (!allowed.includes(service) || !source || !existsSync(source)) {
  console.error('Usage: node scripts/import-runtime.mjs syncthing /path/to/executable')
  process.exit(2)
}
const platform = os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'macos' : 'linux'
const names = platform === 'windows'
  ? { syncthing: 'syncthing.exe' }
  : { syncthing: 'syncthing' }
const dest = join(root, 'runtime', platform, service, names[service])
mkdirSync(dirname(dest), { recursive: true })
copyFileSync(source, dest)
if (platform !== 'windows') chmodSync(dest, 0o755)
console.log(`Imported ${basename(source)} -> ${dest}`)
console.log('Tauri bundling includes runtime/**/* as application resources.')
