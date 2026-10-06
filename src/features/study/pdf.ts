import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { convertFileSrc } from '@tauri-apps/api/core'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }

/** A book's bytes from the library, through the `bdbook` scheme (study.rs serves library books only). */
export async function loadBookBytes(course: string, file: string) {
  const response = await fetch(convertFileSrc(`${course}/${file}`, 'bdbook'))
  if (!response.ok) throw new Error(`The book couldn't be opened (${response.status}). Has it finished syncing?`)
  return response.arrayBuffer()
}

/** A PDF book from the library. */
export async function loadBook(course: string, file: string) {
  return pdfjs.getDocument({ data: new Uint8Array(await loadBookBytes(course, file)), isEvalSupported: false }).promise
}
