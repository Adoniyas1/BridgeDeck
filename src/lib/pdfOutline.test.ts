import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { labelRuns, outlineWithin, type Bookmark } from './pdfOutline'
import { splitPdf } from './pdfwrite'

const BOOK: Bookmark[] = [
  { title: 'Preface', page: 1, items: [] },
  { title: '1 Circuits', page: 3, items: [
    { title: '1.1 Current', page: 4, items: [{ title: 'Kirchhoff', page: 5, items: [] }] },
    { title: '1.2 Voltage', page: 6, items: [] },
  ] },
  { title: '2 Signals', page: 8, items: [
    { title: '2.1 Sine waves', page: 9, items: [] },
    { title: '2.2 Phasors', page: 11, items: [{ title: 'Worked example', page: 12, items: [] }] },
  ] },
  { title: 'Problems (link broken)', page: null, items: [{ title: 'Set 2', page: 12, items: [] }] },
]

/** The bookmarks of a PDF as pdf.js reads them: title, page (from 1) and entries. */
async function readBack(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise
  type Raw = Array<{ title: string; dest: unknown; items: Raw }>
  const walk = async (items: Raw | null): Promise<Bookmark[]> => Promise.all((items ?? []).map(async i => {
    const dest = typeof i.dest === 'string' ? await doc.getDestination(i.dest) : i.dest as unknown[] | null
    return { title: i.title, page: Array.isArray(dest) && dest[0] ? (await doc.getPageIndex(dest[0] as never)) + 1 : null, items: await walk(i.items) }
  }))
  return { pages: doc.numPages, outline: await walk(await doc.getOutline() as Raw | null), labels: await doc.getPageLabels() }
}

describe('a chapter keeps its contents and page numbers', () => {
  it('takes the part of the contents in a range, counted from its first page', () => {
    expect(outlineWithin(BOOK, 8, 12)).toEqual([
      { title: '2 Signals', page: 1, items: [{ title: '2.1 Sine waves', page: 2, items: [] }, { title: '2.2 Phasors', page: 4, items: [{ title: 'Worked example', page: 5, items: [] }] }] },
      { title: 'Problems (link broken)', page: null, items: [{ title: 'Set 2', page: 5, items: [] }] },
    ])
    // A range starting inside a chapter keeps its sections (their chapter heading is elsewhere).
    expect(outlineWithin(BOOK, 4, 5)).toEqual([{ title: '1.1 Current', page: 1, items: [{ title: 'Kirchhoff', page: 2, items: [] }] }])
  })

  it('stores page labels as runs', () => {
    expect(labelRuns(['i', 'ii', 'iii', '1', '2', '3', 'A-1', 'A-2', '7'])).toEqual([
      { index: 0, style: 'r', first: 1, prefix: '' },
      { index: 3, style: 'D', first: 1, prefix: '' },
      { index: 6, style: null, first: 1, prefix: 'A-1' },
      { index: 7, style: null, first: 1, prefix: 'A-2' },
      { index: 8, style: 'D', first: 7, prefix: '' },
    ])
  })

  it('splits a book into chapter files that keep their bookmarks and the book’s page numbers', async () => {
    const book = await PDFDocument.create()
    for (let i = 0; i < 12; i++) book.addPage([300, 400])
    const bytes = await book.save()
    const labels = ['i', 'ii', ...Array.from({ length: 10 }, (_, i) => String(i + 1))]
    const [one, two] = await splitPdf(bytes.buffer.slice(0) as ArrayBuffer, [{ start: 3, end: 7 }, { start: 8, end: 12 }], undefined, { outline: BOOK, labels })

    const first = await readBack(one)
    expect(first.pages).toBe(5)
    expect(first.outline).toEqual([{ title: '1 Circuits', page: 1, items: [
      { title: '1.1 Current', page: 2, items: [{ title: 'Kirchhoff', page: 3, items: [] }] },
      { title: '1.2 Voltage', page: 4, items: [] },
    ] }])
    expect(first.labels).toEqual(['1', '2', '3', '4', '5'])

    const second = await readBack(two)
    expect(second.outline.map(b => b.title)).toEqual(['2 Signals', 'Problems (link broken)'])
    expect(second.outline[0].items[1]).toEqual({ title: '2.2 Phasors', page: 4, items: [{ title: 'Worked example', page: 5, items: [] }] })
    expect(second.labels).toEqual(['6', '7', '8', '9', '10'])

    // A chapter file can be split again by its own bookmarks.
    const [again] = await splitPdf(two.buffer.slice(0) as ArrayBuffer, [{ start: 4, end: 5 }], undefined, { outline: second.outline, labels: second.labels })
    const third = await readBack(again)
    expect(third.outline).toEqual([
      { title: '2.2 Phasors', page: 1, items: [{ title: 'Worked example', page: 2, items: [] }] },
      { title: 'Problems (link broken)', page: null, items: [{ title: 'Set 2', page: 2, items: [] }] },
    ])
    expect(third.labels).toEqual(['9', '10'])
  })

  it('gives a book without labels its page numbers', async () => {
    const book = await PDFDocument.create()
    for (let i = 0; i < 6; i++) book.addPage([300, 400])
    const [part] = await splitPdf((await book.save()).buffer.slice(0) as ArrayBuffer, [{ start: 4, end: 6 }])
    expect((await readBack(part)).labels).toEqual(['4', '5', '6'])
  })
})
