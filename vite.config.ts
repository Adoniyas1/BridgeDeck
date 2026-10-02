/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

// Text recognition for scanned book pages (Tesseract.js) runs from files inside the app, never a CDN:
// its worker, the WebAssembly engine (with and without SIMD) and the English model, served at /ocr/.
const OCR_FILES: Record<string, string> = {
  'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'eng.traineddata.gz': 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
}

function ocrFiles(): Plugin {
  return {
    name: 'bridgedeck-ocr-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.startsWith('/ocr/') ? req.url.slice(5).split('?')[0] : ''
        const source = name && Object.hasOwn(OCR_FILES, name) ? OCR_FILES[name] : ''
        if (!source) return next()
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(readFileSync(source))
      })
    },
    generateBundle() {
      for (const [name, source] of Object.entries(OCR_FILES)) {
        this.emitFile({ type: 'asset', fileName: `ocr/${name}`, source: readFileSync(source) })
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
