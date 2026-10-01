import { describe, expect, it } from 'vitest'
import type { TransferStatus } from '../../lib/bridge'
import { detail, justFinished, percent, what } from './transfers'

const t = (over: Partial<TransferStatus> = {}): TransferStatus => ({
  id: 'x', direction: 'send', peerId: 'p', peerName: 'Mac', files: 1, names: ['Album/big.mov'], totalBytes: 100_000_000, doneBytes: 25_000_000,
  state: 'sending', error: null, startedAt: 1, finishedAt: null, folder: null, rate: 5_000_000, canResume: false, ...over,
})

describe('transfers', () => {
  it('describes what is moving and how long is left', () => {
    expect(what(t())).toBe('big.mov')
    expect(what(t({ files: 3, names: ['Album/a', 'Album/b', 'Album/c'] }))).toBe('Album (3 files)')
    expect(what(t({ files: 2, names: ['a.pdf', 'b.pdf'] }))).toBe('2 files')
    expect(detail(t())).toBe('25.0 MB of 100.0 MB · 5.0 MB/s · 15 s left')
    expect(detail(t({ state: 'done', direction: 'receive', folder: 'C:\\Users\\me\\Downloads' }))).toBe('100.0 MB · saved to C:\\Users\\me\\Downloads')
    expect(detail(t({ state: 'failed', error: 'The disk is full' }))).toBe('The disk is full')
    expect(percent(t())).toBe(25)
  })

  it('notices transfers that just finished', () => {
    const before = [t(), t({ id: 'y', state: 'done', finishedAt: 5 })]
    const after = [t({ state: 'done', finishedAt: 9 }), t({ id: 'y', state: 'done', finishedAt: 5 })]
    expect(justFinished(before, after).map(x => x.id)).toEqual(['x'])
  })
})
