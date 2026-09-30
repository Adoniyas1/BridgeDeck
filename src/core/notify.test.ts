import { describe, expect, it } from 'vitest'
import { freshTransfers, newConflicts } from './notify'
import type { LocalSendRecent, SyncConflict } from '../types'

const transfer = (sessionId: string, finishedAt: number): LocalSendRecent =>
  ({ sessionId, senderAlias: 'Mac', files: 1, bytes: 10, status: 'received', destination: '', finishedAt })
const conflict = (conflictPath: string): SyncConflict =>
  ({ conflictPath, originalPath: 'a.txt', originalExists: true, conflictSize: 1, originalSize: 1, conflictModified: 0, originalModified: 0 })

describe('notifications', () => {
  it('announces each transfer once, and none from before BridgeDeck opened', () => {
    const seen = new Set<string>()
    expect(freshTransfers([transfer('old', 50), transfer('a', 150)], seen, 100).map(t => t.sessionId)).toEqual(['a'])
    expect(freshTransfers([transfer('b', 200), transfer('a', 150)], seen, 100).map(t => t.sessionId)).toEqual(['b'])
    expect(freshTransfers([transfer('b', 200)], seen, 100)).toEqual([])
  })

  it('finds only conflict copies that are new', () => {
    const before = { shared: [conflict('x.sync-conflict.txt')] }
    const after = { shared: [conflict('x.sync-conflict.txt'), conflict('y.sync-conflict.txt')], other: [conflict('z.sync-conflict.txt')] }
    expect(newConflicts(before, after).map(c => c.conflictPath)).toEqual(['y.sync-conflict.txt', 'z.sync-conflict.txt'])
    expect(newConflicts(after, before)).toEqual([])
  })
})
