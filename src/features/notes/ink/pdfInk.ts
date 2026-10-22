/** Writing on a PDF: its pages become the ink's backgrounds (drawn here once, so the iPad shows
 *  them too), and the annotated PDF is the original with the strokes drawn on each page. */

import type { PDFDocumentProxy } from 'pdfjs-dist'
import { inkSetBackground, inkSetDoc } from '../../../lib/bridge'
import { newDoc, PAGE_SIZES, type InkDoc, type Stroke } from './model'
import { strokePath } from './render'

/** Makes an ink for a PDF: one page each (up to `maxPages`), with the PDF's pages behind. */
export async function inkForPdf(id: string, pdf: PDFDocumentProxy, source: { course: string; file: string }, onPage?: (n: number, of: number) => void, maxPages = 120) {
  const pages = Math.min(pdf.numPages, maxPages)
  const doc: InkDoc = { ...newDoc('pdf'), pages, pdf: source }
  await inkSetDoc(id, JSON.stringify(doc))
  const [w] = PAGE_SIZES.letter
  for (let n = 1; n <= pages; n++) {
    const page = await pdf.getPage(n)
    const base = page.getViewport({ scale: 1 })
    // About 150 dpi for a Letter page: sharp enough to write on, small enough to sync.
    const viewport = page.getViewport({ scale: (w / base.width) * 2 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport, canvas } as Parameters<typeof page.render>[0]).promise
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (blob) await inkSetBackground(id, n - 1, new Uint8Array(await blob.arrayBuffer()))
    page.cleanup()
    onPage?.(n, pages)
  }
  return doc
}

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number]

/** The strokes drawn onto a PDF (the original's pages, or blank paper for a notebook). Ink pages
 *  are Letter-sized; each is scaled onto its PDF page's visible area (the crop box). */
export async function annotatedPdf(strokes: Stroke[], doc: InkDoc, original: ArrayBuffer | null): Promise<Uint8Array> {
  const { PDFDocument, rgb } = await import('pdf-lib')
  const out = original ? await PDFDocument.load(original, { ignoreEncryption: true }) : await PDFDocument.create()
  const [iw, ih] = PAGE_SIZES[doc.size]
  if (!original) for (let i = 0; i < doc.pages; i++) {
    const page = out.addPage([iw, ih])
    if (doc.paper === 'lines') for (let y = 72; y < ih - 24; y += 24) page.drawLine({ start: { x: 36, y: ih - y }, end: { x: iw - 36, y: ih - y }, thickness: 0.6, color: rgb(0.79, 0.84, 0.91) })
  }
  const pages = out.getPages()
  for (const s of strokes) {
    const page = pages[s.page]
    if (!page) continue
    const box = page.getCropBox()
    const scale = Math.min(box.width / iw, box.height / ih)
    const [r, g, b] = hex(s.color)
    page.drawSvgPath(strokePath(s), { x: box.x, y: box.y + box.height, scale, color: rgb(r, g, b), opacity: s.tool === 'hl' ? 0.35 : 1, borderWidth: 0 })
  }
  return out.save()
}
