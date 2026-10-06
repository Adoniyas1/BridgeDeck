/// <reference lib="webworker" />
// Transcribes a recording with Whisper (Transformers.js) in the background, on this computer. The
// model and the speech engine come from the bdmodel scheme (downloaded once, src-tauri/src/models.rs);
// nothing is sent anywhere. Messages in: { audio: Float32Array (16 kHz mono), repo, base, engine, loader }.
// Out: { progress: 0..1 } while working, then { segments: [{ start, end, text }] } or { error }.
import { env, pipeline } from '@huggingface/transformers'

const CHUNK = 30 // seconds per piece (Whisper's window)
const RATE = 16000

self.onmessage = async (event: MessageEvent<{ audio: Float32Array; repo: string; base: string; engine: string; loader: string }>) => {
  const { audio, repo, base, engine, loader } = event.data
  try {
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = base
    env.useBrowserCache = false
    const wasm = env.backends.onnx.wasm
    if (wasm) {
      wasm.wasmPaths = { wasm: engine, mjs: loader }
      wasm.numThreads = 1
    }
    const asr = await pipeline('automatic-speech-recognition', repo, { dtype: 'q8', device: 'wasm' })
    const segments: Array<{ start: number; end: number; text: string }> = []
    const pieces = Math.max(1, Math.ceil(audio.length / (CHUNK * RATE)))
    for (let i = 0; i < pieces; i++) {
      const piece = audio.subarray(i * CHUNK * RATE, Math.min(audio.length, (i + 1) * CHUNK * RATE))
      const out = await asr(piece, { return_timestamps: true }) as { text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }
      const offset = i * CHUNK
      const chunks = out.chunks?.length ? out.chunks : [{ timestamp: [0, piece.length / RATE] as [number, number], text: out.text }]
      for (const c of chunks) {
        const text = c.text.trim()
        if (text) segments.push({ start: offset + (c.timestamp[0] ?? 0), end: offset + (c.timestamp[1] ?? piece.length / RATE), text })
      }
      self.postMessage({ progress: (i + 1) / pieces })
    }
    self.postMessage({ segments })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
