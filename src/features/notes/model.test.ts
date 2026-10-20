import { describe, expect, it } from 'vitest'
import type { Note, NoteBlock } from '../../lib/bridge'
import { layoutGraph } from './graph'
import { MIMIR_MEMORY_ID, sectionOf, allTags, backlinks, between, bumpLabel, diff, displayMath, findByTitle, graphOf, linkQuery, linksOf, dueItems, firstSubLabel, inline, labelOnly, matches, nextLabel, noteTitle, rebase, remindersDue, shortcut, sortNotes, subProgress, toggleTask, toMarkdown, visible } from './model'

const block = (id: string, pos: string, over: Partial<NoteBlock> = {}): NoteBlock =>
  ({ id, kind: 'p', text: '', checked: false, due: null, pos, updated: 1, by: 'mac', deleted: false, ...over })
const note = (over: Partial<Note> = {}): Note =>
  ({ id: 'n1', title: '', folder: '', pinned: false, kind: 'note', created: 1, titleUpdated: 1, metaUpdated: 1, deleted: false, blocks: [], seq: 1, ...over })

describe('between', () => {
  it('always finds a key strictly between, however often you insert in the same place', () => {
    const keys = ['i']
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(random() * (keys.length + 1))
      const key = between(keys[at - 1] ?? '', keys[at] ?? '')
      if (at > 0) expect(key > keys[at - 1]).toBe(true)
      if (at < keys.length) expect(key < keys[at]).toBe(true)
      expect(key).toMatch(/^[0-9A-Za-z]*[1-9A-Za-z]$/)
      keys.splice(at, 0, key)
    }
    // Repeatedly inserting at the front and back.
    let first = 'i'
    let last = 'i'
    for (let i = 0; i < 200; i++) {
      const before = between('', first); expect(before < first).toBe(true); first = before
      const after = between(last, ''); expect(after > last).toBe(true); last = after
    }
  })
})

describe('notes', () => {
  it('shows blocks in position order without deletion markers, and names untitled notes by their first line', () => {
    const n = note({ blocks: [block('b', 'm', { text: 'second' }), block('a', 'c', { text: 'first line\nmore' }), block('x', 'a', { deleted: true })] })
    expect(visible(n).map(b => b.id)).toEqual(['a', 'b'])
    expect(noteTitle(n)).toBe('first line')
    expect(noteTitle(note({ kind: 'list' }))).toBe('Untitled checklist')
  })

  it('turns typed markdown into blocks', () => {
    expect(shortcut('# Plan')).toEqual({ kind: 'h1', text: 'Plan' })
    expect(shortcut('[] milk')).toEqual({ kind: 'todo', text: 'milk' })
    expect(shortcut('- [x] done')).toEqual({ kind: 'todo', text: 'done', checked: true })
    expect(shortcut('- item')).toEqual({ kind: 'li', text: 'item' })
    expect(shortcut('1. one')).toEqual({ kind: 'ol', text: 'one' })
    expect(shortcut('plain')).toBeNull()
  })

  it('renders inline formatting as pieces, never HTML', () => {
    expect(inline('a **b** `c` *d* [e](https://x.org) <script>')).toEqual([
      { kind: 'text', text: 'a ' }, { kind: 'bold', text: 'b' }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'c' },
      { kind: 'text', text: ' ' }, { kind: 'italic', text: 'd' }, { kind: 'text', text: ' ' }, { kind: 'link', text: 'e', href: 'https://x.org' },
      { kind: 'text', text: ' <script>' },
    ])
    expect(inline('see https://example.com/a.')).toEqual([{ kind: 'text', text: 'see ' }, { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' }, { kind: 'text', text: '.' }])
    expect(inline('[x](javascript:alert(1))').every(p => p.kind !== 'link')).toBe(true)
  })

  it('exports Markdown', () => {
    const n = note({ title: 'Trip', blocks: [block('a', 'a', { kind: 'h2', text: 'Pack' }), block('b', 'b', { kind: 'todo', text: 'passport', checked: true }), block('c', 'c', { kind: 'ol', text: 'one' }), block('d', 'd', { kind: 'ol', text: 'two' }), block('e', 'e', { text: 'end' })] })
    expect(toMarkdown(n)).toBe('# Trip\n\n## Pack\n- [x] passport\n1. one\n2. two\nend\n')
  })

  it('searches every word, and sorts pinned notes first', () => {
    const n = note({ title: 'Groceries', blocks: [block('a', 'a', { text: 'oat milk' })] })
    expect(matches(n, 'milk groc')).toBe(true)
    expect(matches(n, 'milk bread')).toBe(false)
    const sorted = sortNotes([note({ id: 'old-pinned', pinned: true }), note({ id: 'new', created: 99 })])
    expect(sorted.map(x => x.id)).toEqual(['old-pinned', 'new'])
  })

  it('announces a due item once, and not when it is long overdue at start', () => {
    const now = 10 * 86_400_000
    const n = note({ blocks: [block('a', 'a', { kind: 'todo', text: 'call', due: now - 1000 }), block('b', 'b', { kind: 'todo', text: 'old', due: now - 3 * 86_400_000 }), block('c', 'c', { kind: 'todo', text: 'later', due: now + 5000 }), block('d', 'd', { kind: 'todo', text: 'done', due: now - 10, checked: true })] })
    expect(dueItems([n]).map(i => i.block.id)).toEqual(['b', 'a', 'c'])
    const announced = new Set<string>()
    expect(remindersDue([n], now, announced).map(i => i.block.id)).toEqual(['a'])
    expect(remindersDue([n], now, announced)).toEqual([])
    expect(remindersDue([n], now + 6000, announced).map(i => i.block.id)).toEqual(['c'])
  })

  it('saves only what changed, and keeps unsaved typing when the other computer’s version arrives', () => {
    const base = note({ blocks: [block('a', 'a', { text: 'one' }), block('b', 'b', { text: 'two' })] })
    const draft = { ...base, title: 'T', blocks: [{ ...base.blocks[0], text: 'one!' }, block('c', 'c', { text: 'new' })] }
    expect(diff(base, base)).toBeNull()
    expect(diff(base, draft)).toEqual({ id: 'n1', title: 'T', blocks: [draft.blocks[0], draft.blocks[1]], removed: ['b'] })
    const stored = { ...base, blocks: [block('a', 'a', { text: 'one' }), block('b', 'b', { text: 'two' }), block('pc', 'z', { text: 'from pc' })] }
    const merged = rebase(stored, base, draft)
    expect(visible(merged).map(b => b.text)).toEqual(['one!', 'new', 'from pc'])
    expect(merged.title).toBe('T')
  })
})

describe('sub-tasks', () => {
  const todo = (id: string, text: string, indent = 0, checked = false) => block(id, id, { kind: 'todo', text, indent, checked })

  it('ticks a task with its sub-tasks, and a task when all its sub-tasks are done', () => {
    const list = [todo('a', 'Ch 11'), todo('b', 'Ch 11.1', 1), todo('c', 'Ch 11.2', 1), todo('d', 'Ch 12')]
    expect(toggleTask(list, 'a').map(b => [b.id, b.checked])).toEqual([['a', true], ['b', true], ['c', true]])
    const oneDone = [todo('a', 'Ch 11'), todo('b', 'Ch 11.1', 1, true), todo('c', 'Ch 11.2', 1), todo('d', 'Ch 12')]
    expect(toggleTask(oneDone, 'c').map(b => [b.id, b.checked])).toEqual([['a', true], ['c', true]])
    const allDone = [todo('a', 'Ch 11', 0, true), todo('b', 'Ch 11.1', 1, true), todo('c', 'Ch 11.2', 1, true)]
    expect(toggleTask(allDone, 'b').map(b => [b.id, b.checked])).toEqual([['a', false], ['b', false]])
    expect(subProgress(oneDone, 0)).toEqual({ done: 1, total: 2 })
    expect(subProgress(oneDone, 3)).toBeNull()
  })

  it('numbers new sub-tasks and the next ones, but leaves plain text alone', () => {
    expect(firstSubLabel('Ch 11')).toBe('Ch 11.1 ')
    expect(firstSubLabel('11.2 Intro')).toBe('11.2.1 ')
    expect(firstSubLabel('Buy milk')).toBe('')
    expect(nextLabel('Ch 11.1', 'Ch 11')).toBe('Ch 11.2 ')
    expect(nextLabel('Ch 11.2 Exercises', 'Ch 11', 'Ch 11.1 Reading')).toBe('Ch 11.3 ')
    expect(nextLabel('Step 2', undefined, 'Step 1')).toBe('Step 3 ')
    expect(nextLabel('Buy 2 apples')).toBe('')
    expect(nextLabel('Ch 12', 'Ch 11')).toBe('')
    expect([labelOnly('Ch 11.3 '), labelOnly('Ch 11.3 Intro'), labelOnly('Buy milk')]).toEqual([true, false, false])
    expect(bumpLabel('Ch 11')).toBe('Ch 12 ')
  })

  it('exports nesting as indented Markdown', () => {
    const n = note({ title: 'Book', blocks: [block('a', 'a', { kind: 'todo', text: 'Ch 11' }), block('b', 'b', { kind: 'todo', text: 'Ch 11.1', indent: 1, checked: true })] })
    expect(toMarkdown(n)).toBe('# Book\n\n- [ ] Ch 11\n  - [x] Ch 11.1\n')
  })
})

describe('links, tags and math', () => {
  const n = (id: string, title: string, text: string) => note({ id, title, blocks: [block(`${id}b`, 'a', { text })] })

  it('reads [[links]], #tags and $math$ as pieces', () => {
    expect(inline('See [[Thesis|my thesis]] and #study/exam, cost $5 and $x^2$ then #1 not a tag')).toEqual([
      { kind: 'text', text: 'See ' }, { kind: 'wikilink', text: 'my thesis', target: 'Thesis' }, { kind: 'text', text: ' and' },
      { kind: 'text', text: ' ' }, { kind: 'tag', text: 'study/exam' }, { kind: 'text', text: ', cost $5 and ' }, { kind: 'math', text: 'x^2' },
      { kind: 'text', text: ' then #1 not a tag' },
    ])
    expect(displayMath('$$\\int_0^1 x\\,dx$$')).toBe('\\int_0^1 x\\,dx')
    expect(displayMath('just text')).toBeNull()
  })

  it('finds links, backlinks, tags and what is being linked as you type', () => {
    const thesis = n('t', 'Thesis', 'Main #school')
    const ch11 = n('c', 'Chapter 11', 'Part of [[thesis]] #school #reading')
    const other = n('o', '', 'Untitled points to [[Chapter 11]]')
    expect(findByTitle([thesis, ch11], 'THESIS')?.id).toBe('t')
    expect(linksOf(ch11)).toEqual(['thesis'])
    expect(backlinks([thesis, ch11, other], thesis).map(x => x.id)).toEqual(['c'])
    expect(allTags([thesis, ch11])).toEqual([['school', 2], ['reading', 1]])
    expect(graphOf([thesis, ch11, other])).toEqual([['c', 't'], ['o', 'c']])
    expect(linkQuery('go to [[Chap', 12)).toEqual({ start: 6, query: 'Chap' })
    expect(linkQuery('done [[x]] now', 14)).toBeNull()
  })

  it('lays out the graph inside the box, linked notes closer than unlinked ones', () => {
    const at = layoutGraph(['a', 'b', 'c'], [['a', 'b']], 400, 300)
    for (const p of at.values()) expect(p.x >= 20 && p.x <= 380 && p.y >= 20 && p.y <= 280).toBe(true)
    const d = (x: string, y: string) => Math.hypot(at.get(x)!.x - at.get(y)!.x, at.get(x)!.y - at.get(y)!.y)
    expect(d('a', 'b')).toBeLessThan(d('a', 'c'))
  })
})

describe('sections', () => {
  const note = (over: Partial<Note>): Note => ({ id: 'n', title: '', folder: '', pinned: false, kind: 'note', created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, blocks: [], seq: 0, ...over })
  it('keeps the person’s notes, checklists and Mimir’s notes apart', () => {
    expect(sectionOf(note({}))).toBe('mine')
    expect(sectionOf(note({ kind: 'list' }))).toBe('lists')
    expect(sectionOf(note({ mimir: true, kind: 'list' }))).toBe('mimir')
    expect(sectionOf(note({ id: MIMIR_MEMORY_ID }))).toBe('mimir')
  })
})
