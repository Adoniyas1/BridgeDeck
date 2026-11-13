import { notesSave, studyPatchCourseInfo, studyRenameBooks, studyStateGet, studyStateSet, type CourseInfo, type Note } from '../../lib/bridge'
import { notesStore } from '../notes/state'
import { bookLink, chaptersTitle, highlightsTitle } from './model'
import { chapterFileNames } from './chapters'
import { readCollections, type Collection } from './collections'

/** "Electric Circuits — 12 Chapter 5 The Operational Amplifier.pdf": a chapter file named the old
 *  way, with the book's name and its place in the contents. */
const OLD = /^.+? — \d{2,} (.+)$/

/** The new names for a collection's chapter files (as a split names them now: "05 The Operational
 *  Amplifier.pdf"), for the files whose name changes. Files not named by a split keep their names. */
export function renamedChapterFiles(files: string[]): Array<{ from: string; to: string }> {
  const parts = files.map(f => { const dot = f.lastIndexOf('.'); return dot > 0 ? [f.slice(0, dot), f.slice(dot)] : [f, ''] })
  if (!parts.some(([stem]) => OLD.test(stem))) return []
  const names = chapterFileNames(parts.map(([stem]) => stem.match(OLD)?.[1] ?? stem))
  return files.flatMap((from, i) => {
    if (!OLD.test(parts[i][0])) return []
    const to = `${names[i]}${parts[i][1]}`
    return to === from ? [] : [{ from, to }]
  })
}

/** A note's text with its links to the renamed books pointed at their new names. */
export function relink(text: string, course: string, renames: Map<string, string>): string {
  if (!text.includes('book:')) return text
  let out = text
  for (const [from, to] of renames) {
    // The link without its page: "book:<course>/<file>#"
    const prefix = bookLink(course, from, 1).replace(/1$/, '')
    if (out.includes(prefix)) out = out.split(prefix).join(bookLink(course, to, 1).replace(/1$/, ''))
  }
  return out
}

/** The course's settings with the renamed files in place: collections, chapter starts set by hand,
 *  and where homework sections were found. */
export function renamedInfo(info: CourseInfo, renames: Map<string, string>): Partial<CourseInfo> {
  const rename = (f: string) => renames.get(f) ?? f
  const collections: Collection[] = readCollections(info).map(c => ({ ...c, files: c.files.map(rename) }))
  const patch: Partial<CourseInfo> = { collections }
  if (info.chapters && typeof info.chapters === 'object') {
    patch.chapters = Object.fromEntries(Object.entries(info.chapters as Record<string, unknown>).map(([f, v]) => [rename(f), v]))
  }
  if (info.sectionPages && typeof info.sectionPages === 'object') {
    patch.sectionPages = Object.fromEntries(Object.entries(info.sectionPages as Record<string, unknown>).map(([k, v]) =>
      [k, v && typeof v === 'object' && typeof (v as { file?: unknown }).file === 'string' ? { ...(v as object), file: rename((v as { file: string }).file) } : v]))
  }
  return patch
}

/** Renames a collection's chapter files the new way, carrying everything that refers to them by
 *  name: the course's settings, where each was being read, links in notes (highlights, cards), and
 *  the titles of each file's highlights and chapter-checklist notes. */
export async function renameChapterFiles(course: string, info: CourseInfo, collection: Collection): Promise<number> {
  const wanted = renamedChapterFiles(collection.files)
  if (!wanted.length) return 0
  const renames = new Map(await studyRenameBooks(course, wanted.map(w => [w.from, w.to] as [string, string])))
  if (!renames.size) return 0
  await studyPatchCourseInfo(course, renamedInfo(info, renames))
  // Where each was being read (synced between the computers).
  const reading = await studyStateGet('reading').catch(() => ({} as Record<string, unknown>))
  const moved = Object.fromEntries([...renames].flatMap(([from, to]) => reading[`${course}/${from}`] ? [[`${course}/${to}`, reading[`${course}/${from}`]]] : []))
  if (Object.keys(moved).length) await studyStateSet('reading', moved).catch(() => undefined)
  // Links in notes (highlights, flashcards, anything that points at a page), and the notes the
  // reader finds by the book's name: its highlights and its chapter checklist.
  const stem = (f: string) => f.replace(/\.[^.]+$/, '')
  const titles = new Map([...renames].flatMap(([from, to]) => [[highlightsTitle(stem(from)), highlightsTitle(stem(to))], [chaptersTitle(stem(from)), chaptersTitle(stem(to))]]))
  const notes: Note[] = notesStore.get().filter(n => !n.deleted && (titles.has(n.title) || n.blocks.some(b => b.text.includes('book:'))))
  for (const note of notes) {
    const blocks = note.blocks.filter(b => !b.deleted && relink(b.text, course, renames) !== b.text).map(b => ({ ...b, text: relink(b.text, course, renames) }))
    const title = titles.get(note.title)
    if (!blocks.length && !title) continue
    const saved = await notesSave({ id: note.id, ...(blocks.length ? { blocks } : {}), ...(title ? { title } : {}) })
    notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
  }
  return renames.size
}
