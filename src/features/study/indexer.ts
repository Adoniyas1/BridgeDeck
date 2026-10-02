import { studySaveIndex, type StudyLibrary } from '../../lib/bridge'
import { createStore } from '../../core/store'
import { loadBook } from './pdf'

/** The most text kept from one page (a dense page is ~5,000 characters). */
const PAGE_LIMIT = 20_000

export const indexStore = createStore<{ book: string; done: number; total: number; failed: string[] }>({ book: '', done: 0, total: 0, failed: [] })
let running = false

/** Page text from pdf.js text items: spaces between items, a newline where a line ends. */
export function pageText(items: Array<{ str?: string; hasEOL?: boolean }>) {
  let out = ''
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    out += item.str
    out += item.hasEOL ? '\n' : (item.str && !item.str.endsWith(' ') ? ' ' : '')
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, PAGE_LIMIT)
}

/** Reads the text of every PDF not yet in the search index, one book at a time. */
export async function indexLibrary(library: StudyLibrary, onBookDone?: () => void) {
  if (running) return
  const todo = library.courses.flatMap(c => c.books.filter(b => b.kind === 'pdf' && !b.indexed).map(b => ({ course: c.name, book: b })))
    .filter(t => !indexStore.get().failed.includes(`${t.course}/${t.book.file}`))
  if (!todo.length) return
  running = true
  try {
    for (const { course, book } of todo) {
      indexStore.set(s => ({ ...s, book: book.title, done: 0, total: 0 }))
      try {
        const doc = await loadBook(course, book.file)
        const pages: string[] = []
        indexStore.set(s => ({ ...s, total: doc.numPages }))
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n)
          pages.push(pageText((await page.getTextContent()).items as Array<{ str?: string; hasEOL?: boolean }>))
          page.cleanup()
          if (n % 10 === 0) indexStore.set(s => ({ ...s, done: n }))
        }
        await doc.destroy()
        await studySaveIndex(course, book.file, book.bytes, pages)
        onBookDone?.()
      } catch {
        indexStore.set(s => ({ ...s, failed: [...s.failed, `${course}/${book.file}`] }))
      }
    }
  } finally {
    running = false
    indexStore.set(s => ({ ...s, book: '', done: 0, total: 0 }))
  }
}
