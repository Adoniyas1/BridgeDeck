import type { CourseInfo, StudyBook } from '../../lib/bridge'

/** A course's files grouped into a bigger book ("Midterm 1", "Lab manual"), in reading order. Kept in
 *  the course's `.course.json` (as `collections`), so both computers see the same groups. A file is
 *  in at most one collection; files in none are listed on their own. */
export type Collection = { id: string; title: string; files: string[]; /** Shown as one book: its files are the chapters. */ book?: boolean }

export const MAX_TITLE = 80

/** The collections saved in a course's info, ignoring anything malformed. */
export function readCollections(info: CourseInfo | undefined): Collection[] {
  const raw = (info as { collections?: unknown } | undefined)?.collections
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Collection[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { id, title, files, book } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || typeof title !== 'string') continue
    const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string' && !seen.has(f)) : []
    list.forEach(f => seen.add(f))
    out.push({ id, title: title.slice(0, MAX_TITLE), files: list, ...(book === true ? { book: true } : {}) })
  }
  return out
}

export function withCollections(info: CourseInfo, collections: Collection[]): CourseInfo {
  return { ...info, collections } as CourseInfo
}

/** The course's files sorted into its collections (in their saved order) and the rest. */
export function groupFiles(books: StudyBook[], collections: Collection[]) {
  const byFile = new Map(books.map(b => [b.file, b]))
  const placed = new Set<string>()
  const groups = collections.map(collection => {
    const items = collection.files.map(f => byFile.get(f)).filter((b): b is StudyBook => !!b && !placed.has(b.file))
    items.forEach(b => placed.add(b.file))
    return { collection, books: items }
  })
  return { groups, loose: books.filter(b => !placed.has(b.file)) }
}

export function addCollection(collections: Collection[], title: string, id: string): Collection[] {
  const clean = title.trim().slice(0, MAX_TITLE)
  return clean ? [...collections, { id, title: clean, files: [] }] : collections
}

export function renameCollection(collections: Collection[], id: string, title: string): Collection[] {
  const clean = title.trim().slice(0, MAX_TITLE)
  return clean ? collections.map(c => c.id === id ? { ...c, title: clean } : c) : collections
}

/** Shows a collection as one book (its files are the chapters) or as files. */
export function setBook(collections: Collection[], id: string, book: boolean): Collection[] {
  return collections.map(c => c.id === id ? (book ? { ...c, book: true } : { id: c.id, title: c.title, files: c.files }) : c)
}

/** The book folder a file is a chapter of, with its chapters in order (existing files only). */
export function bookOf(collections: Collection[], file: string, existing: Set<string>) {
  const c = collections.find(x => x.book && x.files.includes(file))
  return c ? { ...c, files: c.files.filter(f => existing.has(f)) } : null
}

/** Removes a collection; its files stay in the course, just not grouped. */
export function removeCollection(collections: Collection[], id: string): Collection[] {
  return collections.filter(c => c.id !== id)
}

/** Puts a file at the end of a collection (taking it out of any other), or out of all of them (`to` null). */
export function moveFile(collections: Collection[], file: string, to: string | null): Collection[] {
  return collections.map(c => {
    const files = c.files.filter(f => f !== file)
    return c.id === to ? { ...c, files: [...files, file] } : files.length === c.files.length ? c : { ...c, files }
  })
}

/** Moves a file up (-1) or down (+1) within its collection, among the files that still exist. */
export function reorder(collections: Collection[], id: string, file: string, delta: -1 | 1, existing: Set<string>): Collection[] {
  const target = collections.find(c => c.id === id)
  if (!target) return collections
  const files = target.files.filter(f => existing.has(f))
  const at = files.indexOf(file)
  const to = at + delta
  if (at < 0 || to < 0 || to >= files.length) return collections
  ;[files[at], files[to]] = [files[to]!, files[at]!]
  return collections.map(c => c.id === id ? { ...c, files } : c)
}

/** Moves a whole collection up or down the list. */
export function reorderCollection(collections: Collection[], id: string, delta: -1 | 1): Collection[] {
  const list = [...collections]
  const at = list.findIndex(c => c.id === id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= list.length) return collections
  ;[list[at], list[to]] = [list[to]!, list[at]!]
  return list
}
