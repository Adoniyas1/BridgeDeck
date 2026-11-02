import { describe, expect, it } from 'vitest'
import { chapterAt, chapterFileNames, chaptersFromOutline, fromStarts, savedStarts } from './chapters'
import { bookOf, readCollections, setBook } from './collections'

import type { OutlineItem } from './model'
const item = (title: string, page: number | null, items: OutlineItem[] = []): OutlineItem => ({ title, page, items })

describe('chapters', () => {
  it('come from the contents, each running to the next', () => {
    const ch = chaptersFromOutline([item('Preface', 5), item('1 Signals', 12), item('2 Diodes', 40), item('Index', 300)], 320)
    expect(ch).toEqual([
      { title: 'Front matter', start: 1, end: 4 }, { title: 'Preface', start: 5, end: 11 }, { title: '1 Signals', start: 12, end: 39 },
      { title: '2 Diodes', start: 40, end: 299 }, { title: 'Index', start: 300, end: 320 },
    ])
    expect(chapterAt(ch, 45)).toBe(3)
  })
  it('use the level under a few parts', () => {
    const ch = chaptersFromOutline([item('Part I', 1, [item('1 A', 1), item('2 B', 20), item('3 C', 40)]), item('Part II', 60, [item('4 D', 60), item('5 E', 80)])], 100)
    expect(ch.map(c => c.title)).toEqual(['1 A', '2 B', '3 C', '4 D', '5 E'])
  })
  it('can be set by hand, and name split files', () => {
    expect(fromStarts([{ title: 'B', page: 50 }, { title: 'A', page: 1 }, { title: 'bad', page: 999 }], 100)).toEqual([{ title: 'A', start: 1, end: 49 }, { title: 'B', start: 50, end: 100 }])
    expect(savedStarts({ chapters: { 'x.pdf': [{ title: 'Ch 1', page: 3 }, { title: 'no page' }] } }, 'x.pdf')).toEqual([{ title: 'Ch 1', page: 3 }])
  })
  it('name split chapter files by chapter, with the front and back matter apart', () => {
    expect(chapterFileNames(['Cover', 'Preface', 'Contents', 'Chapter 1: Functions and Models', 'Chapter 2 Limits', '3. Derivatives', 'Diodes: basics?', 'Appendix A Numbers', 'Answers to Odd-Numbered Exercises', 'Index'])).toEqual([
      '00.1 Cover', '00.2 Preface', '00.3 Contents', '01 Functions and Models', '02 Limits', '03 Derivatives', '04 Diodes basics', 'Appendix A Numbers', 'Answers to Odd-Numbered Exercises', 'Index',
    ])
    // One piece of front matter; "Introduction" first is front matter, later it's a chapter.
    expect(chapterFileNames(['Preface', 'Signals', 'Systems'])).toEqual(['00 Preface', '01 Signals', '02 Systems'])
    expect(chapterFileNames(['Introduction', '1 Basics'])).toEqual(['00 Introduction', '01 Basics'])
    expect(chapterFileNames(['1 Basics', 'Introduction to Filters'])).toEqual(['01 Basics', '02 Introduction to Filters'])
    // Section numbers and years aren't chapter numbers; numbers already used aren't reused.
    expect(chapterFileNames(['1.1 Vectors', '2019 Exam', 'Chapter 5', '5 Again'])).toEqual(['01 1.1 Vectors', '02 2019 Exam', '05 Chapter 5', '06 Again'])
  })
  it('book folders open as one book', () => {
    const cols = setBook(readCollections({ code: '', title: '', canvasId: '', canvasCode: '', collections: [{ id: 'a', title: 'Sedra', files: ['1.pdf', '2.pdf', 'gone.pdf'] }] }), 'a', true)
    expect(bookOf(cols, '2.pdf', new Set(['1.pdf', '2.pdf']))?.files).toEqual(['1.pdf', '2.pdf'])
    expect(bookOf(setBook(cols, 'a', false), '2.pdf', new Set(['2.pdf']))).toBeNull()
  })
})
