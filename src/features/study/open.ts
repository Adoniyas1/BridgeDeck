import { openBeside, openTab } from '../../core/tabs'
import { parseBookLink, parseLectureLink } from './model'

/** Opens a book in its own tab, at a page; with `beside`, on the right of a split screen. */
export function openBook(course: string, file: string, title: string, page = 0, beside = false) {
  const tab = { id: `book:${course}/${file}`, kind: 'study-book', title, params: { course, file, title, page: String(page), at: String(Date.now()) } }
  if (beside) openBeside(tab)
  else openTab(tab)
}

/** A `book:` link from a note. */
export function openBookLink(href: string) {
  const link = parseBookLink(href)
  if (link) openBook(link.course, link.file, link.file.replace(/\.[^.]+$/, ''), link.page)
}

/** A lecture recording with its transcript in its own tab, at a time (seconds). */
export function openLecture(course: string, file: string, t = 0, beside = false) {
  const tab = { id: `lecture:${course}/${file}`, kind: 'study-lecture', title: file.replace(/\.[^.]+$/, ''), params: { course, file, t: String(t), at: String(Date.now()) } }
  if (beside) openBeside(tab)
  else openTab(tab)
}

/** A `lecture:` link from a note. */
export function openLectureLink(href: string) {
  const link = parseLectureLink(href)
  if (link) openLecture(link.course, link.file, link.t)
}
