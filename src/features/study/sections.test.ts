import { describe, expect, it } from 'vitest'
import type { StudyBook } from '../../lib/bridge'
import { answersPage, findPlaces, sectionPage, textbooks } from './sections'

type Item = { title: string; page: number | null; items: Item[] }
const item = (title: string, page: number | null, items: Item[] = []): Item => ({ title, page, items })
const outline = [
  item('Chapter 10 Parametric Equations', 640, [item('10.1 Curves Defined by Parametric Equations', 642), item('10.2 Calculus with Parametric Curves', 652), item('10.10 Review', 700)]),
  item('Appendixes', 1000, [item('Answers to Odd-Numbered Exercises', 1050)]),
]

describe('homework sections in the book', () => {
  it('finds a section and the answers in the contents', () => {
    expect(sectionPage(outline, '10.1')).toBe(642)
    expect(sectionPage(outline, '10.10')).toBe(700)
    expect(sectionPage(outline, '10.3')).toBeNull()
    expect(sectionPage([item('Section 4.2 Mean Value', 90)], '4.2')).toBe(90)
    expect(answersPage(outline)).toBe(1050)
  })
  it('looks in the textbook first and only for what is not saved', async () => {
    const book = (file: string, bytes: number, title = file): StudyBook => ({ file, title, kind: 'pdf', bytes, indexed: true })
    const books = [book('slides.pdf', 9e9, 'Week 1 slides'), book('small.pdf', 10), book('stewart.pdf', 5e8)]
    expect(textbooks(books).map(b => b.file)).toEqual(['stewart.pdf', 'small.pdf'])
    const asked: string[] = []
    const found = await findPlaces({ code: '', title: '', canvasId: '', canvasCode: '', sectionPages: { '10.2': { file: 'x.pdf', page: 1 } } }, books, ['10.1', '10.2', 'answers'], async f => { asked.push(f); return f === 'stewart.pdf' ? outline : [] })
    expect(found).toEqual({ '10.1': { file: 'stewart.pdf', page: 642 }, answers: { file: 'stewart.pdf', page: 1050 } })
    expect(asked).toEqual(['stewart.pdf'])
  })
})
