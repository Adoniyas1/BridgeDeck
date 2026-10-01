import type { TransferStatus } from '../../lib/bridge'
import { fmtSize } from '../../core/util'

export const active = (t: TransferStatus) => t.finishedAt === null

/** "3 files", or the one file's name. */
export function what(t: TransferStatus) {
  if (t.files === 1) return t.names[0]?.split('/').pop() || '1 file'
  const folder = t.names[0]?.includes('/') && t.names.every(n => n.split('/')[0] === t.names[0].split('/')[0]) ? t.names[0].split('/')[0] : null
  return folder ? `${folder} (${t.files} files)` : `${t.files} files`
}

function duration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`
}

/** The line under a transfer: progress and speed while it runs, the outcome after. */
export function detail(t: TransferStatus) {
  const size = `${fmtSize(t.doneBytes)} of ${fmtSize(t.totalBytes)}`
  switch (t.state) {
    case 'connecting': return t.direction === 'send' ? `Connecting to ${t.peerName}…` : 'Starting…'
    case 'retrying': return `Connection lost, trying again… (${size})`
    case 'sending':
    case 'receiving': {
      const left = t.rate > 0 ? (t.totalBytes - t.doneBytes) / t.rate : 0
      return t.rate > 0 ? `${size} · ${fmtSize(t.rate)}/s · ${duration(left)} left` : size
    }
    case 'done': return `${fmtSize(t.totalBytes)} · ${t.direction === 'send' ? `sent to ${t.peerName}` : `saved${t.folder ? ` to ${t.folder}` : ''}`}`
    case 'cancelled': return `Cancelled at ${size}`
    default: return t.error || 'Failed'
  }
}

export function percent(t: TransferStatus) {
  return t.totalBytes ? Math.min(100, (t.doneBytes / t.totalBytes) * 100) : t.state === 'done' ? 100 : 0
}

/** Transfers that finished between two lists (for notifications). */
export function justFinished(before: TransferStatus[], after: TransferStatus[]) {
  const running = new Set(before.filter(active).map(t => `${t.direction}:${t.id}`))
  return after.filter(t => !active(t) && running.has(`${t.direction}:${t.id}`))
}
