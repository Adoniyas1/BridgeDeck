import type { OutlineItem } from './model'

/** A chapter: its title and the pages it covers (from 1, inclusive). */
export type Chapter = { title: string; start: number; end: number }

/** A book's chapters from its contents: the top level, or the level under it when the top is just a
 *  few parts ("Part I", "Part II"). Entries without a page, and ones before the previous, are left
 *  out; each chapter runs to the page before the next one. */
export function chaptersFromOutline(outline: OutlineItem[] | null, pages: number): Chapter[] {
  if (!outline?.length || pages < 1) return []
  const withPage = (items: OutlineItem[]) => items.filter(i => i.page != null && i.page >= 1 && i.page <= pages)
  let level = withPage(outline)
  const deeper = outline.flatMap(i => withPage(i.items))
  if (level.length <= 3 && deeper.length > level.length * 2) level = deeper
  return fromStarts(level.map(i => ({ title: i.title.replace(/\s+/g, ' ').trim(), page: i.page! })), pages)
}

/** Chapters from (title, first page) pairs, in page order, each running to the next one. */
export function fromStarts(starts: Array<{ title: string; page: number }>, pages: number): Chapter[] {
  const sorted = [...starts].filter(s => s.title && s.page >= 1 && s.page <= pages).sort((a, b) => a.page - b.page)
  const out: Chapter[] = []
  for (const s of sorted) {
    if (out.length && out[out.length - 1].start === s.page) continue
    out.push({ title: s.title.slice(0, 120), start: s.page, end: pages })
  }
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start - 1
  // Front matter before the first chapter.
  if (out.length && out[0].start > 1) out.unshift({ title: 'Front matter', start: 1, end: out[0].start - 1 })
  return out
}

/** The chapter a page is in (its index), or -1. */
export const chapterAt = (chapters: Chapter[], page: number) => chapters.findIndex(c => page >= c.start && page <= c.end)

/** Chapters someone set for a book with no usable contents, kept in the course settings as
 *  `chapters: { [file]: [{ title, page }] }`. */
export function savedStarts(info: { chapters?: unknown }, file: string): Array<{ title: string; page: number }> {
  const all = info.chapters && typeof info.chapters === 'object' ? (info.chapters as Record<string, unknown>)[file] : null
  if (!Array.isArray(all)) return []
  return all.flatMap(c => typeof c?.title === 'string' && Number.isInteger(c?.page) && c.page >= 1 ? [{ title: c.title.trim().slice(0, 120), page: c.page as number }] : []).slice(0, 300)
}

/** What comes before the chapters, and after them: not numbered as chapters. */
const FRONT = /^(cover|front ?matter|half[- ]?title|title page|copyright|dedication|epigraph|(brief |detailed |table of )?contents|preface|foreword|prologue|acknowledge?ments?|about the authors?|to the (student|instructor|reader)|how to use|guided tour|list of (figures|tables|symbols|abbreviations)|notation|symbols|introduction)\b/i
const BACK = /^(appendi(x|ces)|answers?|solutions?|index|glossary|bibliography|references|further reading|selected (answers|bibliography)|credits|photo credits|epilogue|afterword|back ?matter|(reference )?tables)\b/i
/** "Chapter 3: Diodes", "Ch. 3 Diodes", "3. Diodes", "3 Diodes": its own number (not "3.1 …"). */
const NUMBERED = /^(?:chapter|chap\.?|ch\.?|unit|lesson|module)?\s*(\d{1,3})(?!\.?\d)\s*[.:)\-–—]?\s*(.*)$/i

const cleanTitle = (title: string) => title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)

/** File names for the chapters split out of a book (they're kept in a collection named after the
 *  book, so the book isn't in them): "01 Functions and Models", by the chapter's own number when its
 *  title has one. The front matter before the first chapter (cover, preface, contents…) comes first as
 *  "00 Preface", or "00.1 Cover", "00.2 Preface" when there are several; appendices, answers and the
 *  index after the chapters keep their own titles, unnumbered. */
export function chapterFileNames(titles: string[]): string[] {
  const kinds = titles.map((t, i) => {
    const title = cleanTitle(t)
    if (BACK.test(title)) return 'back'
    // An "Introduction" is front matter only before the first chapter; later on it's a chapter.
    if (FRONT.test(title) && !titles.slice(0, i).some(p => !FRONT.test(cleanTitle(p)) && !BACK.test(cleanTitle(p)))) return 'front'
    return 'chapter'
  })
  const fronts = kinds.filter(k => k === 'front').length
  const width = Math.max(2, String(titles.length).length)
  let frontNo = 0, last = 0
  return titles.map((t, i) => {
    const title = cleanTitle(t)
    if (kinds[i] === 'front') return `00${fronts > 1 ? `.${++frontNo}` : ''} ${title || 'Front matter'}`
    if (kinds[i] === 'back') return title || 'Back matter'
    const own = title.match(NUMBERED)
    const no = own && Number(own[1]) > last ? Number(own[1]) : last + 1
    last = no
    const name = (own ? own[2].trim() : title) || `Chapter ${no}`
    return `${String(no).padStart(width, '0')} ${name}`
  })
}
