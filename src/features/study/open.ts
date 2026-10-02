import { openTab } from '../../core/tabs'
import { parseBookLink } from './model'

/** Opens a book in its own tab, at a page. */
export function openBook(course: string, file: string, title: string, page = 0) {
  openTab({ id: `book:${course}/${file}`, kind: 'study-book', title, params: { course, file, title, page: String(page), at: String(Date.now()) } })
}

/** A `book:` link from a note. */
export function openBookLink(href: string) {
  const link = parseBookLink(href)
  if (link) openBook(link.course, link.file, link.file.replace(/\.[^.]+$/, ''), link.page)
}
