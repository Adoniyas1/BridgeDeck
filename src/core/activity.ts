import { listen } from '@tauri-apps/api/event'
import { activityAdd, commandWatch, isTauri } from '../lib/bridge'
import { setNotice } from './notice'

/** The window's part of the activity log (Settings → Activity & safety): the actions it takes
 *  (each native command that changes something: saving, sending, starting, running…), anything that
 *  fails or takes long, and which tabs are opened. Only command names and outcomes: never what was
 *  typed, sent or saved. Entries are sent a few at a time, and repeats are counted, not repeated. */

type Entry = { kind: 'info' | 'warn' | 'error'; source: string; message: string; count: number }
const queue: Entry[] = []
let timer: number | undefined

/** Commands that change something, by the words in their names (the rest are reads and polls,
 *  logged only when they fail or crawl). A read word wins: bridgelink_poll_pair is a poll. */
const ACTION = new Set(['save', 'delete', 'remove', 'create', 'send', 'start', 'stop', 'run', 'install', 'update', 'add', 'set', 'pair', 'approve', 'decline', 'forget', 'import', 'restore', 'backup', 'clear', 'publish', 'accept', 'move', 'rename', 'upgrade', 'connect', 'disconnect', 'toggle', 'open', 'launch', 'kill', 'apply', 'write', 'record', 'undo', 'confirm', 'request', 'refresh', 'control'])
const READ = new Set(['status', 'poll', 'list', 'get', 'read', 'info', 'versions', 'version', 'load', 'peek', 'settings', 'check', 'probe', 'fetch', 'search', 'ping', 'files', 'languages', 'library', 'catalog', 'progress', 'workspace', 'path', 'state'])
const QUIET = /^(activity_|error_log_|tray_update|safety_status|hardware_info)/
const SLOW_MS = 5000

export function logActivity(source: string, message: string, kind: Entry['kind'] = 'info') {
  if (!isTauri() || !message) return
  const last = queue[queue.length - 1]
  if (last && last.source === source && last.message === message && last.kind === kind) last.count++
  else queue.push({ kind, source, message: message.slice(0, 2000), count: 1 })
  if (queue.length > 300) queue.splice(0, queue.length - 300)
  timer ??= window.setTimeout(flush, 2000)
}

function flush() {
  timer = undefined
  const entries = queue.splice(0).map(e => ({ kind: e.kind, source: e.source, message: e.count > 1 ? `${e.message} (×${e.count})` : e.message }))
  if (entries.length) void activityAdd(entries).catch(() => undefined)
}

/** What a finished command means for the log, if anything (exported for tests). */
export function describeCommand(command: string, ms: number, error?: string): Pick<Entry, 'kind' | 'message'> | null {
  if (QUIET.test(command)) return null
  const took = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
  if (error) return { kind: 'warn', message: `${command} failed after ${took}: ${error.slice(0, 500)}` }
  if (ms >= SLOW_MS) return { kind: 'info', message: `${command} took ${took}` }
  const words = command.toLowerCase().split('_')
  if (!words.some(w => READ.has(w)) && words.some(w => ACTION.has(w))) return { kind: 'info', message: `${command} (${took})` }
  return null
}

export function installActivityLog() {
  commandWatch.done = (command, ms, error) => {
    const entry = describeCommand(command, ms, error)
    if (entry) logActivity('command', entry.message, entry.kind)
  }
  window.addEventListener('beforeunload', flush)
  // The safety stop stepped in (src-tauri/src/watchdog.rs): say so.
  if (isTauri()) void listen<string>('safety-stop', event => setNotice(event.payload)).catch(() => undefined)
}
