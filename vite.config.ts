/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
