/** Where a homework section is in the course's book ("10.1" → p. 642), and where its answers are
 *  (the "Answers to odd-numbered exercises" at the back). Found from the books' contents and kept in
 *  the course's settings as `sectionPages` ({"10.1": {file, page}, "answers": {file, page}}), so
 *  each is looked up once and can be set by hand. */

import type { CourseInfo, StudyBook } from '../../lib/bridge'
import type { OutlineItem } from './model'

export type Place = { file: string; page: number }
export const ANSWERS = 'answers'

export function savedPlaces(info: { sectionPages?: unknown }): Record<string, Place> {
  const raw = info.sectionPages
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, Place> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as Partial<Place> | null
    if (p && typeof p.file === 'string' && Number.isInteger(p.page) && p.page! >= 1) out[k] = { file: p.file, page: p.page! }
  }
  return out
}

const flat = (items: OutlineItem[]): OutlineItem[] => items.flatMap(i => [i, ...flat(i.items)])

/** The page where `section` ("10.1") starts: an entry titled "10.1 …", "Section 10.1 …" or "§10.1". */
export function sectionPage(outline: OutlineItem[], section: string): number | null {
  const escaped = section.replace(/\./g, '\\.')
  const pattern = new RegExp(`^\\s*(?:section\\s*|§\\s*)?${escaped}(?![\\d])`, 'i')
  return flat(outline).find(i => i.page != null && pattern.test(i.title))?.page ?? null
}

/** The page of the answers at the back of the book. */
export function answersPage(outline: OutlineItem[]): number | null {
  const pattern = /\b(answers?|solutions?)\b.*\b(odd|selected|exercises?|problems?)\b|^\s*answers\b/i
  const found = flat(outline).filter(i => i.page != null && pattern.test(i.title))
  return found.length ? found[found.length - 1].page : null
}

/** The books to look in, most likely first: PDFs that aren't slides, the biggest (the textbook) first. */
export function textbooks(books: StudyBook[]): StudyBook[] {
  return books.filter(b => b.kind === 'pdf' && !/slides?|lecture|syllabus|exam/i.test(b.title)).sort((a, b) => b.bytes - a.bytes)
}

/** Looks up places not saved yet, in each textbook's contents in turn; returns what was found. */
export async function findPlaces(info: CourseInfo, books: StudyBook[], wanted: string[], outlineOf: (file: string) => Promise<OutlineItem[]>): Promise<Record<string, Place>> {
  const saved = savedPlaces(info)
  const missing = wanted.filter(w => !saved[w])
  const found: Record<string, Place> = {}
  for (const book of textbooks(books)) {
    if (!missing.some(w => !found[w])) break
    let outline: OutlineItem[]
    try { outline = await outlineOf(book.file) } catch { continue }
    for (const w of missing) {
      if (found[w]) continue
      const page = w === ANSWERS ? answersPage(outline) : sectionPage(outline, w)
      if (page) found[w] = { file: book.file, page }
    }
  }
  return found
}
