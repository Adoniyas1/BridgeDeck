import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { convertFileSrc } from '@tauri-apps/api/core'
import { studySlidesPdf } from '../../lib/bridge'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { OutlineItem } from './model'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }

/** A presentation (read as the PDF made from it on this computer). */
export const isSlideFile = (file: string) => /\.(pptx?|key|odp)$/i.test(file)

/** A book's bytes from the library, through the `bdbook` scheme (study.rs serves library books only). */
export async function loadBookBytes(course: string, file: string) {
  if (isSlideFile(file)) await studySlidesPdf(course, file)
  const response = await fetch(convertFileSrc(`${course}/${file}`, 'bdbook'))
  if (!response.ok) throw new Error(`The book couldn't be opened (${response.status}). Has it finished syncing?`)
  return response.arrayBuffer()
}

/** A PDF book from the library. Read in pieces as pages are shown (study.rs serves byte ranges), so
 *  a 400 MB textbook opens at once; if that doesn't work in this window, the whole file is loaded. */
export async function loadBook(course: string, file: string) {
  if (isSlideFile(file)) await studySlidesPdf(course, file)
  const task = pdfjs.getDocument({ url: convertFileSrc(`${course}/${file}`, 'bdbook'), rangeChunkSize: 1 << 20, disableAutoFetch: true, disableStream: true, isEvalSupported: false })
  try {
    return await task.promise
  } catch {
    void task.destroy()
    return pdfjs.getDocument({ data: new Uint8Array(await loadBookBytes(course, file)), isEvalSupported: false }).promise
  }
}

type RawOutline = Array<{ title: string; dest: unknown; items: RawOutline }>

/** A book's contents with page numbers (from 1); entries whose link is broken have no page. */
export async function resolveOutline(doc: PDFDocumentProxy, items: RawOutline | null): Promise<OutlineItem[]> {
  if (!items) return []
  return Promise.all(items.map(async item => {
    let page: number | null = null
    try {
      const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest as unknown[] | null
      if (Array.isArray(dest) && dest[0]) page = (await doc.getPageIndex(dest[0] as never)) + 1
    } catch { /* a broken link in the book: no page */ }
    return { title: item.title, page, items: await resolveOutline(doc, item.items) }
  }))
}

/** A library book's contents, read without showing it. */
export async function bookOutline(course: string, file: string): Promise<OutlineItem[]> {
  const doc = await loadBook(course, file)
  try { return await resolveOutline(doc, await doc.getOutline() as RawOutline | null) } finally { void doc.destroy() }
}
