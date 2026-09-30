import { desktopNotify } from '../lib/bridge'
import type { LocalSendRecent, SyncConflict } from '../types'
import { configStore } from './config'

/** Kinds of desktop notification the user can turn off. Remote control starting and pairing
 *  requests always notify: someone else is reaching this computer. */
export type NotifyKind = 'messages' | 'ai' | 'files' | 'sync'

export function notify(kind: NotifyKind, title: string, body: string) {
  if (!configStore.get().notifications[kind]) return
  void desktopNotify(title, body).catch(() => undefined)
}

/** Transfers that ended since BridgeDeck opened and haven't been announced yet (marks them seen). */
export function freshTransfers(recent: LocalSendRecent[], seen: Set<string>, since: number) {
  const fresh = recent.filter(item => item.finishedAt >= since && !seen.has(`${item.sessionId}:${item.finishedAt}`))
  recent.forEach(item => seen.add(`${item.sessionId}:${item.finishedAt}`))
  return fresh
}

/** Conflict copies in `after` that weren't in `before`. */
export function newConflicts(before: Record<string, SyncConflict[]>, after: Record<string, SyncConflict[]>) {
  const known = new Set(Object.values(before).flat().map(c => c.conflictPath))
  return Object.values(after).flat().filter(c => !known.has(c.conflictPath))
}
