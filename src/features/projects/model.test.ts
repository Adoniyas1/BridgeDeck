import { describe, expect, it } from 'vitest'
import type { Note, NoteBlock, NotePatch } from '../../lib/bridge'
import { toMarkdown } from '../notes/model'
import { addCard, boardColumns, boardProgress, countdown, moveCard, tickCard } from './model'

const b = (id: string, kind: NoteBlock['kind'], text: string, pos: string, extra: Partial<NoteBlock> = {}): NoteBlock => ({ id, kind, text, checked: false, due: null, pos, updated: 0, by: '', deleted: false, ...extra })
const board = (): Note => ({ id: 'n', title: 'Robot — board', folder: 'Projects/Robot', pinned: false, kind: 'list', created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, seq: 0, blocks: [
  b('h1', 'h2', 'To do', 'a'), b('c1', 'todo', 'Order motors', 'b'), b('s1', 'todo', 'Check torque', 'c', { indent: 1 }), b('c2', 'todo', 'CAD the chassis', 'd'),
  b('h2', 'h2', 'Doing', 'e'), b('h3', 'h2', 'Done', 'f'),
] })
const apply = (note: Note, patch: NotePatch | null): Note => ({ ...note, blocks: note.blocks.map(x => patch!.blocks!.find(p => p.id === x.id) ?? x).concat(patch!.blocks!.filter(p => !note.blocks.some(x => x.id === p.id))) })
const shape = (note: Note) => boardColumns(note).map(c => `${c.title}: ${c.cards.map(k => `${k.block.checked ? 'x' : ' '}${k.block.text}${k.subs.length ? `(+${k.subs.length})` : ''}`).join(', ')}`)

describe('project board', () => {
  it('reads columns from headings with cards and their sub-tasks', () => {
    expect(shape(board())).toEqual(['To do:  Order motors(+1),  CAD the chassis', 'Doing: ', 'Done: '])
    expect(toMarkdown(board())).toContain('## To do')
  })

  it('moves cards with their sub-tasks, ticking them in the done column', () => {
    let note = apply(board(), moveCard(board(), 'c1', 2, -1))
    expect(shape(note)).toEqual(['To do:  CAD the chassis', 'Doing: ', 'Done: xOrder motors(+1)'])
    expect(note.blocks.find(x => x.id === 's1')!.checked).toBe(true)
    note = apply(note, moveCard(note, 'c2', 2, -1))
    expect(shape(note)).toEqual(['To do: ', 'Doing: ', 'Done: xCAD the chassis, xOrder motors(+1)'])
    note = apply(note, addCard(note, 1, '  Wire   the ESC '))
    note = apply(note, addCard(note, 1, 'Test drive'))
    expect(shape(note)[1]).toBe('Doing:  Wire the ESC,  Test drive')
    // Reorder within a column: Test drive to the top.
    const testDrive = boardColumns(note)[1].cards[1].block.id
    note = apply(note, moveCard(note, testDrive, 1, -1))
    expect(shape(note)[1]).toBe('Doing:  Test drive,  Wire the ESC')
    expect(boardProgress(note)).toEqual({ done: 2, total: 4 })
  })

  it('ticking sends a card to Done and unticking brings it back to the first column', () => {
    let note = apply(board(), tickCard(board(), 'c2', true))
    expect(shape(note)).toEqual(['To do:  Order motors(+1)', 'Doing: ', 'Done: xCAD the chassis'])
    note = apply(note, tickCard(note, 'c2', false))
    expect(shape(note)[0]).toBe('To do:  Order motors(+1),  CAD the chassis')
  })

  it('counts down to milestones', () => {
    const now = new Date(2026, 9, 2, 15).getTime()
    expect([countdown(new Date(2026, 9, 2, 9).getTime(), now), countdown(new Date(2026, 9, 3).getTime(), now), countdown(new Date(2026, 9, 12).getTime(), now), countdown(new Date(2026, 9, 1).getTime(), now)]).toEqual(['today', 'tomorrow', 'in 10 days', '1 day ago'])
  })
})
