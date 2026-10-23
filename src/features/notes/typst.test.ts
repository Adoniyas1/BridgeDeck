import { describe, expect, it } from 'vitest'
import type { Note, NoteBlock } from '../../lib/bridge'
import { escapeText, noteTypst } from './typst'

const block = (kind: NoteBlock['kind'], text: string, extra: Partial<NoteBlock> = {}, i = 0): NoteBlock => ({ id: `b${i}`, kind, text, checked: false, due: null, pos: String.fromCharCode(97 + i), updated: 0, by: '', deleted: false, ...extra })
const note = (blocks: NoteBlock[]): Note => ({ id: 'n', title: 'Circuits #3', folder: '', pinned: false, kind: 'note', created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, seq: 0, blocks: blocks.map((b, i) => ({ ...b, id: `b${i}`, pos: String.fromCharCode(97 + i) })) })

describe('notes as Typst', () => {
  it('escapes markup characters in plain text', () => {
    expect(escapeText('a*b_c #d $5 <x> [y] -z')).toBe('a\\*b\\_c \\#d \\$5 \\<x\\> \\[y\\] \\-z')
  })
  it('turns blocks into Typst with mitex for math', () => {
    const typ = noteTypst(note([
      block('h1', 'Nodes'), block('p', 'KCL: **sum** of $I_k$ is *zero*.'), block('p', '$$\\sum_k I_k = 0$$'),
      block('ol', 'one'), block('ol', 'two'), block('todo', 'check', { checked: true }), block('code', 'x = `1`'), block('ink', 'abc'),
    ]), 'hand')
    expect(typ).toContain('#import "@preview/mitex:0.2.5": mitex, mi')
    expect(typ).toContain('font: ("Kalam"')
    expect(typ).toContain('[Circuits \\#3]')
    expect(typ).toContain('= Nodes')
    expect(typ).toContain('KCL: *sum* of #mi(`I_k`) is _zero_.')
    expect(typ).toContain('#mitex(`\\sum_k I_k = 0`)')
    expect(typ).toContain('1. one\n2. two\n- ☑ check')
    expect(typ).toContain('#raw("x = `1`", block: true)')
    expect(typ).toContain('(handwriting: see the note in BridgeDeck)')
  })
})
