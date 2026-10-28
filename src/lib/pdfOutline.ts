import { PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, type PDFDict, type PDFRef } from 'pdf-lib'

/**
 * A chapter cut out of a book keeps what makes it a book: its part of the contents (the sections
 * and their sub-sections, as bookmarks pointing at the right pages) and the book's page numbers
 * (page 345 is still "345"). Then a chapter file can be read, searched and split again.
 */

/** A contents entry: a title, its page (from 1; null when the book's link is broken), its entries. */
export type Bookmark = { title: string; page: number | null; items: Bookmark[] }

/** The part of a book's contents within pages start–end (from 1), with pages counted from the
 *  chapter's first page. Entries elsewhere are left out; one without a page is kept only for its
 *  entries inside the range. */
export function outlineWithin(items: Bookmark[], start: number, end: number): Bookmark[] {
  return items.flatMap((item): Bookmark[] => {
    const kids = outlineWithin(item.items, start, end)
    const inside = item.page !== null && item.page >= start && item.page <= end
    if (inside) return [{ title: item.title, page: item.page! - start + 1, items: kids }]
    // A heading outside the range (or without a page) whose entries are inside: just the entries.
    return kids.length ? (item.page === null ? [{ title: item.title, page: null, items: kids }] : kids) : []
  })
}

/** Page labels as runs, the way a PDF stores them: a run of plain numbers counting up ("345, 346…")
 *  or of roman numerals ("i, ii…") starts at a page; any other label is its own. */
export type LabelRun = { index: number; style: 'D' | 'r' | 'R' | null; first: number; prefix: string }

const roman = (n: number) => { let out = ''; for (const [v, s] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const) while (n >= v) { out += s; n -= v } return out }
const fromRoman = (s: string) => { for (let n = 1; n < 4000; n++) if (roman(n) === s) return n; return 0 }

function numberOf(label: string): { style: 'D' | 'r' | 'R'; n: number } | null {
  if (/^[1-9]\d{0,5}$/.test(label)) return { style: 'D', n: Number(label) }
  if (/^[ivxlcdm]{1,12}$/.test(label)) { const n = fromRoman(label); return n ? { style: 'r', n } : null }
  if (/^[IVXLCDM]{1,12}$/.test(label)) { const n = fromRoman(label.toLowerCase()); return n ? { style: 'R', n } : null }
  return null
}

export function labelRuns(labels: string[]): LabelRun[] {
  const runs: LabelRun[] = []
  labels.forEach((label, index) => {
    const num = numberOf(label)
    const last = runs[runs.length - 1]
    if (num && last && last.style === num.style && num.n === last.first + (index - last.index)) return
    runs.push(num ? { index, style: num.style, first: num.n, prefix: '' } : { index, style: null, first: 1, prefix: label })
  })
  return runs
}

/** Writes `items` as the document's bookmarks (sections open, deeper levels closed) and shows them
 *  when it opens. */
export function writeOutline(doc: PDFDocument, items: Bookmark[]) {
  if (!items.length) return
  const ctx = doc.context
  const pages = doc.getPages().map(p => p.ref)
  const level = (list: Bookmark[], parent: PDFRef, depth: number): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef())
    let count = list.length
    list.forEach((item, i) => {
      const dict = ctx.obj({}) as PDFDict
      dict.set(PDFName.of('Title'), PDFHexString.fromText(item.title))
      dict.set(PDFName.of('Parent'), parent)
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1])
      if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1])
      if (item.page !== null && pages[item.page - 1]) dict.set(PDFName.of('Dest'), ctx.obj([pages[item.page - 1], PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]))
      if (item.items.length) {
        const sub = level(item.items, refs[i], depth + 1)
        dict.set(PDFName.of('First'), sub.first)
        dict.set(PDFName.of('Last'), sub.last)
        // Open at the top level (the sections show), closed below that.
        dict.set(PDFName.of('Count'), PDFNumber.of(depth === 0 ? sub.count : -sub.count))
        if (depth === 0) count += sub.count
      }
      ctx.assign(refs[i], dict)
    })
    return { first: refs[0], last: refs[refs.length - 1], count }
  }
  const root = ctx.nextRef()
  const top = level(items, root, 0)
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }))
  doc.catalog.set(PDFName.of('Outlines'), root)
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}

/** Writes the pages' labels (one per page, in order). */
export function writePageLabels(doc: PDFDocument, labels: string[]) {
  if (!labels.length) return
  const ctx = doc.context
  const nums: unknown[] = []
  for (const run of labelRuns(labels)) {
    nums.push(run.index)
    const entry = ctx.obj({}) as PDFDict
    if (run.style) { entry.set(PDFName.of('S'), PDFName.of(run.style)); if (run.first !== 1) entry.set(PDFName.of('St'), PDFNumber.of(run.first)) }
    else entry.set(PDFName.of('P'), PDFHexString.fromText(run.prefix))
    nums.push(entry)
  }
  doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: ctx.obj(nums as never) }))
}
