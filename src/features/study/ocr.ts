import { createWorker, OEM, type Worker } from 'tesseract.js'
import { convertFileSrc } from '@tauri-apps/api/core'
import { configStore } from '../../core/config'
import { ocrLanguagesStatus } from '../../lib/bridge'
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api'

/** A page with fewer letters than this is treated as a scan (an image of text) and read by text recognition. */
const SCAN_LETTERS = 20
/** Scans are drawn about this wide for recognition: enough for book print without making recognition slow. */
const TARGET_WIDTH = 2000
/** Words recognised with less confidence than this (0–100) are left out, so smudges don't become noise. */
const MIN_WORD_CONFIDENCE = 40

/** Whether pdf.js found almost no text on a page, so it's probably a scan. */
export function looksScanned(text: string) {
  return (text.match(/\p{L}/gu)?.length ?? 0) < SCAN_LETTERS
}

/** The text of recognised lines, keeping the words recognition is reasonably sure of. */
export function recognisedText(lines: Array<{ words: Array<{ text: string; confidence: number }> }>) {
  return lines
    .map(line => line.words.filter(w => w.confidence >= MIN_WORD_CONFIDENCE).map(w => w.text).join(' ').trim())
    .filter(Boolean)
    .join('\n')
}

// The same check wasm-feature-detect makes: a tiny module using a SIMD instruction.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])

let engine: Promise<Worker> | null = null

/** Starts Tesseract once, from the files bundled at /ocr/ (see vite.config.ts). English comes
 *  with the app; other languages chosen in Settings are read from the ones downloaded
 *  (src-tauri/src/models.rs, served by the bdmodel scheme). Nothing is downloaded here. */
function start() {
  if (!engine) {
    engine = (async () => {
      const base = new URL('/ocr/', location.href).href
      const simd = typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE)
      const chosen = configStore.get().study?.ocrLanguages ?? []
      const have = chosen.length ? await ocrLanguagesStatus().catch(() => [] as string[]) : []
      const extra = chosen.filter(l => l !== 'eng' && have.includes(l))
      const languages = extra.length && have.includes('eng') ? ['eng', ...extra] : ['eng']
      const langPath = languages.length > 1 ? convertFileSrc('tessdata', 'bdmodel') : base.replace(/\/$/, '')
      return createWorker(languages.join('+'), OEM.LSTM_ONLY, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}tesseract-core-${simd ? 'simd-' : ''}lstm.wasm.js`,
        langPath,
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
      })
    })()
    engine.catch(() => { engine = null })
  }
  return engine
}

/** Draws a PDF page and reads its text by recognition. */
export async function recognisePage(page: PDFPageProxy) {
  const worker = await start()
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: Math.min(4, TARGET_WIDTH / base.width) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No canvas to draw the page on')
  await page.render({ canvasContext: context, viewport }).promise
  try {
    const { data } = await worker.recognize(canvas, {}, { text: false, blocks: true })
    const lines = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines))
    return recognisedText(lines)
  } finally {
    canvas.width = canvas.height = 0
  }
}

/** Reads the text in a photo (notes, a whiteboard) at `url`. */
export async function recogniseImage(url: string) {
  const worker = await start()
  const bitmap = await createImageBitmap(await (await fetch(url)).blob())
  const scale = Math.min(1, TARGET_WIDTH / bitmap.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No canvas to draw the photo on')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  try {
    const { data } = await worker.recognize(canvas, {}, { text: false, blocks: true })
    return recognisedText((data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines)))
  } finally {
    canvas.width = canvas.height = 0
  }
}

/** Frees the recognition engine's memory once a run of indexing is over. */
export async function stopRecognition() {
  const running = engine
  engine = null
  if (running) await (await running.catch(() => null))?.terminate()
}
