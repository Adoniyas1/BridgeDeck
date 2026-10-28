import { degrees, PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { outlineWithin, writeOutline, writePageLabels, type Bookmark } from './pdfOutline'

/** One source for a stitched PDF: a PDF (some of its pages, or all) or a picture (one page). */
export type StitchPart = { bytes: ArrayBuffer; kind: 'pdf' | 'image'; mime?: string; pages?: number[]; rotate?: number }

const LETTER: [number, number] = [612, 792]

/** "1-3, 5" as page indexes (from 0) in a document of `count` pages; blank means every page.
 *  Pages out of range are left out; null when the text isn't a page list. */
export function parsePages(text: string, count: number): number[] | null {
  const spec = text.trim()
  if (!spec) return Array.from({ length: count }, (_, i) => i)
  const out: number[] = []
  for (const part of spec.split(/\s*,\s*/)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part)
    if (!m) return null
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])]
    const step = from <= to ? 1 : -1
    for (let p = from; step > 0 ? p <= to : p >= to; p += step) if (p >= 1 && p <= count) out.push(p - 1)
  }
  return out
}

/** A picture pdf-lib can't take (WebP, GIF…) as a JPEG, drawn through a canvas. */
async function asJpeg(bytes: ArrayBuffer, mime: string): Promise<ArrayBuffer> {
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(new Blob([bytes], { type: mime })) } catch {
    throw new Error(mime.includes('heic') ? 'This computer can’t read HEIC photos. On the iPhone, set Camera → Formats → Most Compatible, or send the photo as a JPEG.' : 'A picture couldn’t be read.')
  }
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  if (!blob) throw new Error('A picture couldn’t be converted.')
  return blob.arrayBuffer()
}

/** The parts, in order, as one PDF. Pictures get a Letter-size page each, scaled to fit. */
export async function stitchPdf(parts: StitchPart[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const part of parts) {
    const turn = ((part.rotate ?? 0) % 360 + 360) % 360
    if (part.kind === 'pdf') {
      let source: PDFDocument
      try { source = await PDFDocument.load(part.bytes, { ignoreEncryption: true }) } catch { throw new Error('One of the PDFs couldn’t be read.') }
      const wanted = (part.pages ?? source.getPageIndices()).filter(i => i >= 0 && i < source.getPageCount())
      for (const page of await out.copyPages(source, wanted)) {
        if (turn) page.setRotation(degrees((page.getRotation().angle + turn) % 360))
        out.addPage(page)
      }
      continue
    }
    const mime = part.mime ?? 'image/jpeg'
    const image = mime === 'image/png' ? await out.embedPng(part.bytes)
      : mime === 'image/jpeg' ? await out.embedJpg(part.bytes)
      : await out.embedJpg(await asJpeg(part.bytes, mime))
    // Landscape pictures get a landscape page.
    const [w, h] = image.width > image.height ? [LETTER[1], LETTER[0]] : LETTER
    const scale = Math.min(w / image.width, h / image.height)
    const [iw, ih] = [image.width * scale, image.height * scale]
    const page = out.addPage([w, h])
    page.drawImage(image, { x: (w - iw) / 2, y: (h - ih) / 2, width: iw, height: ih })
    if (turn) page.setRotation(degrees(turn))
  }
  if (!out.getPageCount()) throw new Error('Pick at least one page.')
  return out.save()
}

/** What a book knows about its pages, for its parts to keep: the contents (bookmarks) and each
 *  page's label (null or empty: plain page numbers). */
export type BookPages = { outline?: Bookmark[]; labels?: string[] | null }

/** One PDF cut into parts by page ranges (from 1, inclusive), loading it only once. Each part keeps
 *  its share of the book's contents as bookmarks, and the book's page numbers. */
export async function splitPdf(bytes: ArrayBuffer, ranges: Array<{ start: number; end: number }>, onPart?: (done: number) => void, book: BookPages = {}): Promise<Uint8Array[]> {
  let source: PDFDocument
  try { source = await PDFDocument.load(bytes, { ignoreEncryption: true }) } catch { throw new Error('The PDF couldn’t be read.') }
  const count = source.getPageCount()
  const out: Uint8Array[] = []
  for (const r of ranges) {
    const part = await PDFDocument.create()
    const wanted = Array.from({ length: Math.max(0, Math.min(r.end, count) - r.start + 1) }, (_, i) => r.start - 1 + i)
    if (!wanted.length) throw new Error(`Pages ${r.start}–${r.end} aren’t in this book.`)
    for (const page of await part.copyPages(source, wanted)) part.addPage(page)
    writeOutline(part, outlineWithin(book.outline ?? [], r.start, r.start + wanted.length - 1))
    writePageLabels(part, wanted.map(i => book.labels?.length ? book.labels[i] ?? String(i + 1) : String(i + 1)))
    out.push(await part.save())
    onPart?.(out.length)
  }
  return out
}

/** A plain text page (or pages): a title and numbered lines, for a practice exam's front page. */
export async function textPdf(title: string, lines: string[]): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  // Helvetica here only has Latin-1: anything else is written as "?".
  const latin = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/§/g, 'Sec. ').replace(/[^\x20-\xFF]/g, '?')
  let page = doc.addPage(LETTER)
  let y = LETTER[1] - 72
  page.drawText(latin(title), { x: 72, y, size: 18, font: bold, color: rgb(0, 0, 0) })
  y -= 34
  for (const line of lines) {
    // Long lines wrap at the margin.
    const words = latin(line).split(' ')
    let current = ''
    const flush = () => {
      if (y < 72) { page = doc.addPage(LETTER); y = LETTER[1] - 72 }
      page.drawText(current, { x: 72, y, size: 12, font })
      y -= 18
      current = ''
    }
    for (const w of words) {
      if (current && font.widthOfTextAtSize(`${current} ${w}`, 12) > LETTER[0] - 144) flush()
      current = current ? `${current} ${w}` : w
    }
    flush()
  }
  const bytes = await doc.save()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
