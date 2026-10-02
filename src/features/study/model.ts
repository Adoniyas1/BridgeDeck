import type { CalEvent, Note } from '../../lib/bridge'

/** Notes for a course live in this Notes folder. */
export const courseFolder = (course: string) => `Study/${course}`

export const chaptersTitle = (book: string) => `${book} — chapters`
export const highlightsTitle = (book: string) => `${book} — highlights`

export type OutlineItem = { title: string; page: number | null; items: OutlineItem[] }

/** A book's table of contents as a checklist: chapters, with sections as sub-tasks. */
export function outlineToMarkdown(items: OutlineItem[], depth = 0, maxDepth = 3): string {
  const lines: string[] = []
  for (const item of items) {
    const title = item.title.replace(/\s+/g, ' ').trim()
    if (!title) continue
    lines.push(`${'  '.repeat(depth)}- [ ] ${title}${item.page ? ` (p. ${item.page})` : ''}`)
    if (depth + 1 < maxDepth && item.items.length) {
      const nested = outlineToMarkdown(item.items, depth + 1, maxDepth)
      if (nested) lines.push(nested)
    }
  }
  return lines.join('\n')
}

/** A link back to a page of a book, kept in notes: `book:<course>/<file>#<page>`. */
export function bookLink(course: string, file: string, page: number) {
  return `book:${encode(course)}/${encode(file)}#${page}`
}
/** encodeURIComponent, plus the characters it leaves that would end a Markdown link: ( ) ! ' *. */
const encode = (text: string) => encodeURIComponent(text).replace(/[()!'*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export function parseBookLink(href: string): { course: string; file: string; page: number } | null {
  const m = href.match(/^book:([^/#\s]+)\/([^#\s]+)#(\d+)$/)
  if (!m) return null
  try {
    return { course: decodeURIComponent(m[1]), file: decodeURIComponent(m[2]), page: Number(m[3]) }
  } catch { return null }
}

/** A highlight as note Markdown: the passage, then where it's from. */
export function highlightMarkdown(text: string, book: string, course: string, file: string, page: number) {
  const passage = text.replace(/\s+/g, ' ').trim()
  return `> ${passage}\n\n[${book}, p. ${page}](${bookLink(course, file, page)})`
}

/** The course's notes, checklists first, with their progress. */
export function courseNotes(notes: Note[], course: string) {
  const folder = courseFolder(course).toLowerCase()
  return notes
    .filter(n => n.folder.toLowerCase() === folder)
    .map(note => {
      const todos = note.blocks.filter(b => !b.deleted && b.kind === 'todo')
      return { note, done: todos.filter(b => b.checked).length, total: todos.length }
    })
    .sort((a, b) => Number(b.total > 0) - Number(a.total > 0) || a.note.title.localeCompare(b.note.title))
}

/** Upcoming calendar events for a course: its name in the title. */
export function courseEvents(events: CalEvent[], course: string, now = Date.now()) {
  const name = course.toLowerCase()
  return events.filter(e => !e.deleted && e.title.toLowerCase().includes(name) && (e.repeat || e.end >= now)).sort((a, b) => a.start - b.start)
}

export function fmtBytes(bytes: number) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

/** Focus sessions are kept as calendar events titled like this, so they sync and show in the week. */
export const studiedTitle = (course: string) => `Studied ${course}`

/** Minutes studied for a course (focus sessions in the calendar) between two times. */
export function studyMinutes(events: CalEvent[], course: string, from: number, to: number) {
  const title = studiedTitle(course).toLowerCase()
  return Math.round(events.filter(e => !e.deleted && e.title.toLowerCase() === title && e.end > from && e.start < to)
    .reduce((sum, e) => sum + Math.min(e.end, to) - Math.max(e.start, from), 0) / 60_000)
}

/** Monday 00:00 of this week, local time. */
export function weekStart(now = Date.now()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

/** The paths (`0/3/`) of every entry that has sections. */
export function outlineParents(items: OutlineItem[], path = ''): string[] {
  return items.flatMap((item, i) => item.items.length ? [`${path}${i}/`, ...outlineParents(item.items, `${path}${i}/`)] : [])
}

/** The path to the entry being read: at each level, the last entry starting at or before `page`. */
export function currentPath(items: OutlineItem[], page: number, path = ''): string[] {
  let found = -1
  items.forEach((item, i) => { if (item.page !== null && item.page <= page) found = i })
  if (found < 0) return []
  const here = `${path}${found}/`
  return [here, ...currentPath(items[found].items, page, here)]
}
