import { describe, expect, it } from 'vitest'
import { readInbox } from './MimirInbox'

describe('Mimir inbox', () => {
  it('keeps the kinds it can add and leaves the rest alone', () => {
    const list = readInbox({
      b: { kind: 'deadline', course: 'EE 310', payload: { title: 'HW 5', due: 5 }, at: 2 },
      a: { kind: 'cards', course: 'EE 310', payload: { lines: ['Q :: A'] }, at: 1 },
      c: { kind: 'words', course: 'EE 310', payload: {}, at: 3 },
      d: null,
    })
    expect(list.map(e => [e.id, e.kind])).toEqual([['a', 'cards'], ['b', 'deadline']])
  })
})
