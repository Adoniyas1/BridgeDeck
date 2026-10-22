/// <reference lib="webworker" />
// Transcribes a recording with Whisper (Transformers.js) in the background, on this computer. The
// model and the speech engine come from the bdmodel scheme (downloaded once, src-tauri/src/models.rs);
// nothing is sent anywhere.
//
// Whole recording: in { audio: Float32Array (16 kHz mono), repo, base, engine, loader }; out
// { progress: 0..1 } while working, then { segments: [{ start, end, text }] } or { error }.
// Live: in { live: true, repo, base, engine, loader } once, then { window: Float32Array, offset }
// for each piece heard; out { live: segments } per piece (times from the start of the recording).
import { env, pipeline } from '@huggingface/transformers'

const CHUNK = 30 // seconds per piece (Whisper's window)
const RATE = 16000
type Setup = { repo: string; base: string; engine: string; loader: string }
type Segment = { start: number; end: number; text: string }
/** The speech pipeline as used here (its full type is too big for TypeScript to work out). */
type Asr = (audio: Float32Array, options: { return_timestamps: boolean }) => Promise<unknown>

let live: Promise<Asr> | null = null

function load({ repo, base, engine, loader }: Setup) {
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = base
  env.useBrowserCache = false
  const wasm = env.backends.onnx.wasm
  if (wasm) {
    wasm.wasmPaths = { wasm: engine, mjs: loader }
    wasm.numThreads = 1
  }
  const make = pipeline as unknown as (task: string, model: string, options: object) => Promise<Asr>
  return make('automatic-speech-recognition', repo, { dtype: 'q8', device: 'wasm' })
}

async function piece(asr: Asr, audio: Float32Array, offset: number): Promise<Segment[]> {
  const out = await asr(audio, { return_timestamps: true }) as { text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }
  const chunks = out.chunks?.length ? out.chunks : [{ timestamp: [0, audio.length / RATE] as [number, number | null], text: out.text }]
  return chunks.flatMap(c => {
    const text = c.text.trim()
    return text ? [{ start: offset + (c.timestamp[0] ?? 0), end: offset + (c.timestamp[1] ?? audio.length / RATE), text }] : []
  })
}

self.onmessage = async (event: MessageEvent<Setup & { audio?: Float32Array; live?: boolean; window?: Float32Array; offset?: number }>) => {
  const data = event.data
  try {
    if (data.live) { live = load(data); await live; return }
    if (data.window) {
      if (!live) throw new Error('Live transcription wasn’t started')
      self.postMessage({ live: await piece(await live, data.window, data.offset ?? 0) })
      return
    }
    const audio = data.audio!
    const asr = await load(data)
    const segments: Segment[] = []
    const pieces = Math.max(1, Math.ceil(audio.length / (CHUNK * RATE)))
    for (let i = 0; i < pieces; i++) {
      segments.push(...await piece(asr, audio.subarray(i * CHUNK * RATE, Math.min(audio.length, (i + 1) * CHUNK * RATE)), i * CHUNK))
      self.postMessage({ progress: (i + 1) / pieces })
    }
    self.postMessage({ segments })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
