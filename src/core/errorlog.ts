import { errorLogAdd, isTauri } from '../lib/bridge'

/** Errors the window doesn't handle go to the error log (Settings → Errors and crashes). The same
 *  message is kept once a minute at most, and at most 30 a minute in all, so a loop can't fill it. */
const lastSent = new Map<string, number>()
let minute = 0
let count = 0

export function logError(source: string, message: string, now = Date.now()) {
  if (!isTauri() || !message) return
  if (now - minute > 60_000) { minute = now; count = 0 }
  if (++count > 30) return
  const key = message.slice(0, 300)
  const last = lastSent.get(key)
  if (last !== undefined && now - last < 60_000) return
  lastSent.set(key, now)
  if (lastSent.size > 200) lastSent.clear()
  void errorLogAdd(source, message.slice(0, 4000)).catch(() => undefined)
}

function describe(value: unknown) {
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack.split('\n').slice(1, 8).join('\n')}` : ''}`
  return typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) } catch { return String(value) } })()
}

export function installErrorLog() {
  window.addEventListener('error', e => {
    // Resource load failures (images, scripts) have no message and aren't app errors.
    if (!e.message) return
    logError('window', `${describe(e.error ?? e.message)}${e.filename ? `\n(${e.filename.replace(/^.*\//, '')}:${e.lineno})` : ''}`)
  })
  window.addEventListener('unhandledrejection', e => logError('promise', describe(e.reason)))
}
