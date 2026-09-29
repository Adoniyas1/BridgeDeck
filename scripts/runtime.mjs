import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const command = process.argv[2] || 'status'
const platform = os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'macos' : 'linux'
const base = join(root, 'runtime', platform)
const names = platform === 'windows'
  ? { rustdesk: ['rustdesk','rustdesk.exe'], syncthing: ['syncthing','syncthing.exe'], bluebubbles: ['bluebubbles','BlueBubbles.exe'] }
  : { rustdesk: ['rustdesk','rustdesk'], syncthing: ['syncthing','syncthing'], bluebubbles: ['bluebubbles','BlueBubbles'] }

if (command === 'init') {
  for (const [folder] of Object.values(names)) mkdirSync(join(base, folder), { recursive: true })
  console.log(`Created runtime layout at ${base}`)
}
if (!['init', 'status'].includes(command)) {
  console.error('Usage: node scripts/runtime.mjs [init|status]')
  process.exit(2)
}
let ready = 0
for (const [id, [folder, name]] of Object.entries(names)) {
  const path = join(base, folder, name)
  const ok = existsSync(path)
  if (ok) ready += 1
  console.log(`${ok ? 'OK  ' : 'MISS'} ${id.padEnd(12)} ${path}`)
}
console.log(`\n${ready}/${Object.keys(names).length} standalone runtimes detected for ${platform}.`)
console.log('LocalSend is compiled from vendor/localsend/packages/core in BridgeDeck v0.7 and is intentionally not listed here.')
