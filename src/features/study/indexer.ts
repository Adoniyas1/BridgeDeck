import { studySaveIndex, type StudyLibrary } from '../../lib/bridge'
import { createStore } from '../../core/store'
import { loadBook, loadBookBytes } from './pdf'
import { looksScanned, recognisePage, stopRecognition } from './ocr'

/** The most text kept from one page (a dense page is ~5,000 characters). */
const PAGE_LIMIT = 20_000

export const indexStore = createStore<{ book: string; done: number; total: number; scanned: number; failed: string[] }>({ book: '', done: 0, total: 0, scanned: 0, failed: [] })
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

/** Reads the text of every PDF not yet in the search index, one book at a time. Pages that are scans
 *  (images of text, with almost no text pdf.js can take out) are read by text recognition instead. */
export async function indexLibrary(library: StudyLibrary, onBookDone?: () => void) {
  if (running) return
  const todo = library.courses.flatMap(c => c.books.filter(b => (b.kind === 'pdf' || b.kind === 'epub') && !b.indexed).map(b => ({ course: c.name, book: b })))
    .filter(t => !indexStore.get().failed.includes(`${t.course}/${t.book.file}`))
  if (!todo.length) return
  running = true
  try {
    for (const { course, book } of todo) {
      indexStore.set(s => ({ ...s, book: book.title, done: 0, total: 0, scanned: 0 }))
      try {
        if (book.kind === 'epub') {
          // EPUBs: one "page" per chapter (search results open at that chapter).
          const chapters = await epubChapters(course, book.file)
          await studySaveIndex(course, book.file, book.bytes, chapters)
          onBookDone?.()
          continue
        }
        const doc = await loadBook(course, book.file)
        const pages: string[] = []
        indexStore.set(s => ({ ...s, total: doc.numPages }))
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n)
          let text = pageText((await page.getTextContent()).items as Array<{ str?: string; hasEOL?: boolean }>)
          if (looksScanned(text)) {
            const recognised = (await recognisePage(page)).slice(0, PAGE_LIMIT)
            if (recognised.length > text.length) text = recognised
            indexStore.set(s => ({ ...s, done: n, scanned: s.scanned + 1 }))
          }
          pages.push(text)
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
    await stopRecognition()
    indexStore.set(s => ({ ...s, book: '', done: 0, total: 0, scanned: 0 }))
  }
}

/** The text of each chapter of an EPUB, in reading order. */
async function epubChapters(course: string, file: string): Promise<string[]> {
  const { default: ePub } = await import('epubjs')
  const book = ePub(await loadBookBytes(course, file))
  await book.ready
  const sections = (book.spine as unknown as { spineItems: Array<{ load: (request: unknown) => Promise<Element>; unload: () => void }> }).spineItems
  const out: string[] = []
  indexStore.set(s => ({ ...s, total: sections.length }))
  for (const [i, section] of sections.entries()) {
    const content = await section.load(book.load.bind(book)).catch(() => null)
    out.push(((content?.querySelector('body') ?? content)?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, PAGE_LIMIT))
    section.unload()
    indexStore.set(s => ({ ...s, done: i + 1 }))
  }
  book.destroy()
  return out
}
