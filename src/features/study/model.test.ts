import { describe, expect, it } from 'vitest'
import type { CalEvent, Note } from '../../lib/bridge'
import { bookLink, courseEvents, courseNotes, currentPath, highlightMarkdown, outlineParents, outlineToMarkdown, parseBookLink } from './model'

describe('study', () => {
  it('turns a table of contents into a chapter checklist with sections as sub-tasks', () => {
    const md = outlineToMarkdown([
      { title: 'Chapter 11  Infinite Sequences', page: 693, items: [{ title: '11.1 Sequences', page: 694, items: [{ title: 'deep', page: 695, items: [{ title: 'too deep', page: 1, items: [] }] }] }, { title: '11.2 Series', page: 707, items: [] }] },
      { title: '', page: 1, items: [] },
      { title: 'Index', page: null, items: [] },
    ])
    expect(md).toBe('- [ ] Chapter 11 Infinite Sequences (p. 693)\n  - [ ] 11.1 Sequences (p. 694)\n    - [ ] deep (p. 695)\n  - [ ] 11.2 Series (p. 707)\n- [ ] Index')
  })

  it('links highlights back to the page, even with spaces and symbols in names', () => {
    const link = bookLink('Math 221', 'Calculus (8th ed).pdf', 42)
    expect(parseBookLink(link)).toEqual({ course: 'Math 221', file: 'Calculus (8th ed).pdf', page: 42 })
    expect(parseBookLink('https://example.com')).toBeNull()
    expect(highlightMarkdown('  The limit\n of a sequence ', 'Calculus', 'Math 221', 'calc.pdf', 7)).toBe('> The limit of a sequence\n\n[Calculus, p. 7](book:Math%20221/calc.pdf#7)')
  })

  it('finds a course’s notes with progress and its upcoming exams', () => {
    const note = (id: string, folder: string, todos: boolean[]): Note => ({ id, title: id, folder, pinned: false, kind: 'list', created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, seq: 0,
      blocks: todos.map((checked, i) => ({ id: `${id}${i}`, kind: 'todo' as const, text: 'x', checked, due: null, pos: `${i}`, updated: 0, by: '', deleted: false })) })
    const found = courseNotes([note('a', 'Study/Math 221', [true, false]), note('b', 'Study/Physics', [])], 'Math 221')
    expect(found.map(f => [f.note.id, f.done, f.total])).toEqual([['a', 1, 2]])
    const ev = (title: string, end: number) => ({ id: title, title, start: end - 1, end, deleted: false, repeat: null } as unknown as CalEvent)
    expect(courseEvents([ev('Math 221 midterm', 200), ev('Math 221 old quiz', 50), ev('Physics exam', 300)], 'math 221', 100).map(e => e.title)).toEqual(['Math 221 midterm'])
  })
})

describe('book contents', () => {
  const book = [
    { title: 'Cover', page: 1, items: [] },
    { title: 'Ch 1', page: 29, items: [{ title: '1.1', page: 29, items: [] }, { title: '1.2', page: 39, items: [{ title: '1.2 Exercises', page: 49, items: [] }] }] },
    { title: 'Ch 2', page: 101, items: [{ title: '2.1', page: 101, items: [] }] },
  ]
  it('finds the section being read, at every level', () => {
    expect(currentPath(book, 50)).toEqual(['1/', '1/1/', '1/1/0/'])
    expect(currentPath(book, 40)).toEqual(['1/', '1/1/'])
    expect(currentPath(book, 5)).toEqual(['0/'])
    expect(currentPath(book, 0)).toEqual([])
  })
  it('lists the entries that can be folded', () => {
    expect(outlineParents(book)).toEqual(['1/', '1/1/', '2/'])
  })
})
