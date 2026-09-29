import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(root, 'vendor-lock.json'), 'utf8'))
const vendorDir = join(root, 'vendor')
const tmpDir = join(root, '.vendor-tmp')
const command = process.argv[2] || 'fetch'
// Optional: --only id1,id2 limits fetch/verify to those components (CI only needs localsend).
const onlyArg = process.argv.indexOf('--only')
const only = onlyArg > 0 ? new Set(String(process.argv[onlyArg + 1] || '').split(',').filter(Boolean)) : null
const components = lock.components.filter(component => !only || only.has(component.id))

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function verifyOne(component) {
  const dir = join(vendorDir, component.id)
  const metaPath = join(dir, '.bridgedeck-vendor.json')
  if (!existsSync(dir) || !existsSync(metaPath)) {
    return { ok: false, id: component.id, reason: 'missing' }
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const ok = meta.repo === component.repo && meta.ref === component.ref && String(meta.commit).startsWith(component.commitPrefix)
  return { ok, id: component.id, reason: ok ? 'ok' : 'pin mismatch', meta }
}

function verifyAll() {
  let failed = 0
  for (const component of components) {
    const result = verifyOne(component)
    if (result.ok) console.log(`OK   ${component.id} ${component.ref} ${result.meta.commit}`)
    else { console.error(`FAIL ${component.id}: ${result.reason}`); failed += 1 }
  }
  if (failed) process.exitCode = 1
}

function fetchAll() {
  mkdirSync(vendorDir, { recursive: true })
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  for (const component of components) {
    const dest = join(vendorDir, component.id)
    const temp = join(tmpDir, component.id)
    console.log(`\n==> Fetching ${component.name} ${component.ref}`)
    rmSync(temp, { recursive: true, force: true })
    run('git', ['clone', '--depth', '1', '--branch', component.ref, component.repo, temp], root)
    const commit = git(['rev-parse', 'HEAD'], temp)
    if (!commit.startsWith(component.commitPrefix)) {
      throw new Error(`${component.id}: expected commit prefix ${component.commitPrefix}, got ${commit}`)
    }
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    for (const entry of ['.git']) rmSync(join(temp, entry), { recursive: true, force: true })
    cpSync(temp, dest, { recursive: true })
    writeFileSync(join(dest, '.bridgedeck-vendor.json'), JSON.stringify({
      name: component.name,
      repo: component.repo,
      ref: component.ref,
      commit,
      license: component.license,
      fetchedAt: new Date().toISOString()
    }, null, 2) + '\n')
    console.log(`Vendored ${component.id} @ ${commit}`)
  }

  rmSync(tmpDir, { recursive: true, force: true })
  verifyAll()
}

if (command === 'fetch') fetchAll()
else if (command === 'verify') verifyAll()
else {
  console.error('Usage: node scripts/vendor.mjs [fetch|verify] [--only id1,id2]')
  process.exit(2)
}
