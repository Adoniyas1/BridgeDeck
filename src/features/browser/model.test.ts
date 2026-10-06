import { describe, expect, it } from 'vitest'
import type { Note, NoteBlock } from '../../lib/bridge'
import { addHistory, HISTORY_MAX, pageName, searchHistory, sentLine, sentPages, siteOf } from './model'

const block = (id: string, text: string, by: string, extra: Partial<NoteBlock> = {}): NoteBlock => ({ id, kind: 'todo', text, checked: false, due: null, pos: id, updated: Number(id.replace(/\D/g, '')) || 1, by, deleted: false, ...extra })
const note = (blocks: NoteBlock[], extra: Partial<Note> = {}): Note => ({ id: 'n', title: 'Sent pages', folder: 'Browser', pinned: false, kind: 'list', created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, blocks, seq: 1, ...extra })

describe('browser model', () => {
  it('names sites and pages', () => {
    expect(siteOf('https://www.YouTube.com/watch?v=1')).toBe('youtube.com')
    expect(siteOf('not a url')).toBe('')
    expect(pageName({ url: 'https://en.wikipedia.org/wiki/X', title: '' })).toBe('en.wikipedia.org')
    expect(pageName({ url: 'https://x.org', title: ' Chain rule ' })).toBe('Chain rule')
  })

  it('keeps one history entry per page, newest first, capped', () => {
    let h = addHistory([], { url: 'https://a.org/', title: 'A', at: 1 })
    h = addHistory(h, { url: 'https://b.org/', title: 'B', at: 2 })
    h = addHistory(h, { url: 'https://a.org/', title: '', at: 3 })
    expect(h.map(p => [p.url, p.title])).toEqual([['https://a.org/', 'A'], ['https://b.org/', 'B']])
    expect(addHistory(h, { url: 'about:blank', title: '', at: 4 })).toBe(h)
    for (let i = 0; i < HISTORY_MAX + 5; i++) h = addHistory(h, { url: `https://x.org/${i}`, title: '', at: i })
    expect(h).toHaveLength(HISTORY_MAX)
    expect(searchHistory([{ url: 'https://khanacademy.org', title: 'Khan Academy', at: 1 }], 'khan')).toHaveLength(1)
    expect(searchHistory(h, ' ')).toEqual([])
  })

  it('sends pages as links and lists the ones from the other computer', () => {
    const line = sentLine({ url: 'https://x.org/a b)', title: 'A [great] page' })
    expect(line).toBe('[A  great  page](https://x.org/a%20b%29)')
    const notes = [note([
      block('b1', line, 'other'),
      block('b2', '[Mine](https://mine.org)', 'me'),
      block('b3', '[Opened](https://o.org)', 'other', { checked: true }),
      block('b4', '[Gone](https://g.org)', 'other', { deleted: true }),
      block('b5', 'not a link', 'other'),
      block('b6', '[Newer](https://n.org)', 'other'),
    ]), note([block('c1', '[Elsewhere](https://e.org)', 'other')], { id: 'n2', title: 'Other note' })]
    const sent = sentPages(notes, 'me')
    expect(sent.map(p => p.title)).toEqual(['Newer', 'A  great  page'])
    expect(sent[1].url).toBe('https://x.org/a%20b%29')
    expect(sentPages(notes, '')).toEqual([])
  })
})
