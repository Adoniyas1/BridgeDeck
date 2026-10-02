import { describe, expect, it } from 'vitest'
import type { MangaSeries } from '../../lib/bridge'
import { continueAt, pageForKey, readCount, seriesTitle, sortSeries } from './model'

const series = (progress: MangaSeries['progress'], extra: Partial<MangaSeries> = {}): MangaSeries => ({ name: 'Frieren', chapters: [{ id: 'c1.cbz', title: 'c1' }, { id: 'c2.cbz', title: 'c2' }, { id: 'c3.cbz', title: 'c3' }], meta: {}, progress, hasCover: false, modified: 0, ...extra })

describe('manga', () => {
  it('carries on where you left off', () => {
    expect(continueAt(series({}))).toEqual({ chapter: 'c1.cbz', page: 0 })
    expect(continueAt(series({ last: 'c2.cbz', chapters: { 'c2.cbz': { page: 7, pages: 20, done: false, at: 1 } } }))).toEqual({ chapter: 'c2.cbz', page: 7 })
    expect(continueAt(series({ last: 'c2.cbz', chapters: { 'c2.cbz': { page: 19, pages: 20, done: true, at: 1 } } }))).toEqual({ chapter: 'c3.cbz', page: 0 })
    expect(continueAt(series({ last: 'c3.cbz', chapters: { 'c3.cbz': { page: 9, pages: 10, done: true, at: 1 } } }))).toEqual({ chapter: 'c3.cbz', page: 0 })
    expect(readCount(series({ chapters: { 'c1.cbz': { page: 0, pages: 1, done: true, at: 1 } } }))).toBe(1)
    expect(seriesTitle(series({}, { meta: { title: 'Frieren: Beyond Journey’s End' } }))).toBe('Frieren: Beyond Journey’s End')
    expect(sortSeries([series({}, { name: 'B' }), series({ at: 5 }, { name: 'A' })]).map(s => s.name)).toEqual(['A', 'B'])
  })

  it('turns pages the right way for manga', () => {
    expect(pageForKey('ArrowLeft', 'rtl', 3, 10)).toBe(4)
    expect(pageForKey('ArrowLeft', 'ltr', 3, 10)).toBe(2)
    expect(pageForKey('ArrowRight', 'rtl', 0, 10)).toBe(0)
    expect(pageForKey(' ', 'strip', 9, 10)).toBe(9)
    expect(pageForKey('End', 'strip', 0, 10)).toBe(9)
    expect(pageForKey('x', 'strip', 0, 10)).toBeNull()
  })
})
