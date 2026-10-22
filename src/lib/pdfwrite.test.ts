import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { parsePages, splitPdf, stitchPdf } from './pdfwrite'

async function pdf(pages: number) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([100 + i, 100])
  return (await doc.save()).buffer as ArrayBuffer
}

describe('stitching PDFs', () => {
  it('reads page lists', () => {
    expect(parsePages('', 3)).toEqual([0, 1, 2])
    expect(parsePages('1-3, 5', 10)).toEqual([0, 1, 2, 4])
    expect(parsePages('3-1', 5)).toEqual([2, 1, 0])
    expect(parsePages('2, 9', 4)).toEqual([1])
    expect(parsePages('a-b', 4)).toBeNull()
  })

  it('puts the chosen pages of each PDF together in order, turned as asked', async () => {
    const out = await PDFDocument.load(await stitchPdf([
      { bytes: await pdf(3), kind: 'pdf', pages: [2, 0] },
      { bytes: await pdf(2), kind: 'pdf', rotate: 90 },
    ]))
    expect(out.getPageCount()).toBe(4)
    expect(out.getPages().map(p => Math.round(p.getWidth()))).toEqual([102, 100, 100, 101])
    expect(out.getPages().map(p => p.getRotation().angle)).toEqual([0, 0, 90, 90])
  })

  it('needs at least one page', async () => {
    await expect(stitchPdf([{ bytes: await pdf(2), kind: 'pdf', pages: [] }])).rejects.toThrow('at least one page')
  })
  it('splits a PDF into chapters', async () => {
    const parts = await splitPdf(await pdf(5), [{ start: 1, end: 2 }, { start: 3, end: 5 }])
    const counts = await Promise.all(parts.map(async p => (await PDFDocument.load(p)).getPageCount()))
    expect(counts).toEqual([2, 3])
    await expect(splitPdf(await pdf(2), [{ start: 4, end: 6 }])).rejects.toThrow('aren’t in this book')
  })
})
