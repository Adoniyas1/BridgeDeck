/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

// Text recognition for scanned book pages (Tesseract.js) runs from files inside the app, never a CDN:
// its worker, the WebAssembly engine (with and without SIMD) and the English model, served at /ocr/.
// Lecture transcription (Transformers.js) loads ONNX Runtime's small loader from here too; its large
// WebAssembly is downloaded on first use (src-tauri/src/models.rs).
const OCR_FILES: Record<string, string> = {
  'ocr/worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'ocr/tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'ocr/tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'ocr/eng.traineddata.gz': 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  'ort/ort-wasm-simd-threaded.jsep.mjs': 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
}

// Excalidraw's fonts (drawings in notes), served at /excalidraw/fonts/ instead of a CDN. The large
// Chinese/Japanese font is left out; those characters fall back to a system font.
function folderFiles(dest: string, source: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(source)) {
    if (skip.includes(name)) continue
    const path = join(source, name)
    if (statSync(path).isDirectory()) Object.assign(out, folderFiles(`${dest}/${name}`, path))
    else out[`${dest}/${name}`] = path
  }
  return out
}
Object.assign(OCR_FILES, folderFiles('excalidraw/fonts', 'node_modules/@excalidraw/excalidraw/dist/prod/fonts', ['Xiaolai']))

function ocrFiles(): Plugin {
  return {
    name: 'bridgedeck-ocr-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url ? decodeURIComponent(req.url.slice(1).split('?')[0]) : ''
        const source = name && Object.hasOwn(OCR_FILES, name) ? OCR_FILES[name] : ''
        if (!source) return next()
        res.setHeader('Content-Type', /\.m?js$/.test(name) ? 'text/javascript' : name.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream')
        res.end(readFileSync(source))
      })
    },
    generateBundle() {
      for (const [name, source] of Object.entries(OCR_FILES)) {
        this.emitFile({ type: 'asset', fileName: name, source: readFileSync(source) })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), ocrFiles()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Only the web UI is served from here. Rust build output (locked .exe files on Windows crash
      // the watcher), vendored sources and bundled runtimes are rebuilt by Tauri, not Vite.
      // Mimir (mimir/) is its own project with its own build, served by its own process.
      ignored: ['**/src-tauri/**', '**/vendor/**', '**/runtime/**', '**/.vendor-tmp/**', '**/release/**', '**/mimir/**'],
    },
  },
  // BridgeDeck's tests only; Mimir runs its own (npm test in mimir/).
  test: { include: ['src/**/*.test.{ts,tsx}', 'agent/**/*.test.mjs'] },
})
