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
  return `book:${encodeURIComponent(course)}/${encodeURIComponent(file)}#${page}`
}

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
