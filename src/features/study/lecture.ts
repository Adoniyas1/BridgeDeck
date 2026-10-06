import { convertFileSrc } from '@tauri-apps/api/core'

/** Whisper models offered for lecture transcription (src-tauri/src/models.rs). */
export const MODELS = [
  { id: 'fast', repo: 'onnx-community/whisper-tiny.en', label: 'Fast', size: 41 },
  { id: 'better', repo: 'onnx-community/whisper-base.en', label: 'Better', size: 80 },
] as const
export type ModelId = typeof MODELS[number]['id']
export const ORT_VERSION = '1.22.0-dev.20250409-89f8206ba4'

export type Segment = { start: number; end: number; text: string }

/** "1:05:09" or "4:07". */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** The transcript as a note: paragraphs of about a minute, each starting with its time. */
export function transcriptMarkdown(segments: Segment[], heading: string) {
  const paragraphs: Array<{ start: number; text: string[] }> = []
  for (const s of segments) {
    const last = paragraphs[paragraphs.length - 1]
    if (!last || s.start - last.start >= 60) paragraphs.push({ start: s.start, text: [s.text] })
    else last.text.push(s.text)
  }
  const body = paragraphs.map(p => `**[${clock(p.start)}]** ${p.text.join(' ').replace(/\s+/g, ' ').trim()}`).join('\n\n')
  return `${heading}\n\n${body || '_Nothing was heard in the recording._'}\n`
}

/** A recording as 16 kHz mono samples, which is what Whisper takes. */
export async function toSamples(recording: Blob): Promise<Float32Array> {
  const data = await recording.arrayBuffer()
  const context = new AudioContext({ sampleRate: 16000 })
  try {
    const audio = await context.decodeAudioData(data)
    if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice()
    const mono = new Float32Array(audio.length)
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const channel = audio.getChannelData(c)
      for (let i = 0; i < channel.length; i++) mono[i] += channel[i] / audio.numberOfChannels
    }
    return mono
  } finally {
    void context.close()
  }
}

/** Transcribes samples in a background worker; `onProgress` gets 0..1. */
export function transcribe(audio: Float32Array, model: ModelId, onProgress: (done: number) => void): Promise<Segment[]> {
  const repo = MODELS.find(m => m.id === model)!.repo
  const base = convertFileSrc('', 'bdmodel').replace(/\/?$/, '/')
  const engine = `${base}ort/${ORT_VERSION}/ort-wasm-simd-threaded.jsep.wasm`
  const loader = new URL('/ort/ort-wasm-simd-threaded.jsep.mjs', location.href).href
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ progress?: number; segments?: Segment[]; error?: string }>) => {
      if (typeof e.data.progress === 'number') onProgress(e.data.progress)
      if (e.data.segments) { worker.terminate(); resolve(e.data.segments) }
      if (e.data.error) { worker.terminate(); reject(new Error(e.data.error)) }
    }
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'Transcription stopped')) }
    worker.postMessage({ audio, repo, base, engine, loader }, [audio.buffer])
  })
}
