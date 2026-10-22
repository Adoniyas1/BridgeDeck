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

/** A file name for a chapter split out of a book: "Sedra — 03 Diodes.pdf". */
export function chapterFileName(book: string, index: number, title: string) {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || `Chapter ${index + 1}`
  return `${book.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 50)} — ${String(index + 1).padStart(2, '0')} ${clean}`
}
