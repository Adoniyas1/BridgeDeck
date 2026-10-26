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
export function transcriptMarkdown(segments: Segment[], heading: string, link?: (seconds: number) => string) {
  const paragraphs: Array<{ start: number; text: string[] }> = []
  for (const s of segments) {
    const last = paragraphs[paragraphs.length - 1]
    if (!last || s.start - last.start >= 60) paragraphs.push({ start: s.start, text: [s.text] })
    else last.text.push(s.text)
  }
  const time = (t: number) => link ? `[${clock(t)}](${link(t)})` : `**[${clock(t)}]**`
  const body = paragraphs.map(p => `${time(p.start)} ${p.text.join(' ').replace(/\s+/g, ' ').trim()}`).join('\n\n')
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

export function workerSetup(model: ModelId) {
  const repo = MODELS.find(m => m.id === model)!.repo
  const base = convertFileSrc('', 'bdmodel').replace(/\/?$/, '/')
  const engine = `${base}ort/${ORT_VERSION}/ort-wasm-simd-threaded.jsep.wasm`
  const loader = new URL('/ort/ort-wasm-simd-threaded.jsep.mjs', location.href).href
  return { repo, base, engine, loader }
}

/** Seconds of sound sent at a time while recording. */
export const LIVE_WINDOW = 20

/** A transcript while the class goes on: sound from the microphone in 20-second pieces, each
 *  transcribed in the background as it comes. A piece that arrives while one is still being worked
 *  on waits; when the computer can't keep up, the oldest waiting pieces are skipped (the full pass
 *  at the end fills them in). */
export class LiveTranscriber {
  private worker: Worker
  private queue: Array<{ window: Float32Array; offset: number }> = []
  private busy = true
  constructor(model: ModelId, private onSegments: (segments: Segment[]) => void, private onError: (message: string) => void) {
    this.worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<{ live?: Segment[]; error?: string }>) => {
      if (e.data.error) { this.onError(e.data.error); return }
      if (e.data.live) this.onSegments(e.data.live)
      this.busy = false
      this.next()
    }
    this.worker.onerror = e => this.onError(e.message || 'Live transcription stopped')
    this.worker.postMessage({ live: true, ...workerSetup(model) })
    // The model loading counts as busy; a short wait before the first piece goes.
    window.setTimeout(() => { this.busy = false; this.next() }, 3000)
  }
  push(window: Float32Array, offset: number) {
    this.queue.push({ window, offset })
    if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3)
    this.next()
  }
  private next() {
    if (this.busy || !this.queue.length) return
    const item = this.queue.shift()!
    this.busy = true
    this.worker.postMessage(item, [item.window.buffer])
  }
  stop() { this.worker.terminate() }
}

/** Microphone sound as 16 kHz mono pieces of `seconds` each, handed to `onWindow` with their start
 *  (seconds from now). Returns a function that stops listening. */
export function listenInWindows(stream: MediaStream, seconds: number, onWindow: (samples: Float32Array, offset: number) => void): () => void {
  const context = new AudioContext({ sampleRate: 16000 })
  const source = context.createMediaStreamSource(stream)
  const node = context.createScriptProcessor(4096, 1, 1)
  const size = seconds * 16000
  let buffer = new Float32Array(size), filled = 0, offset = 0
  node.onaudioprocess = e => {
    const input = e.inputBuffer.getChannelData(0)
    let at = 0
    while (at < input.length) {
      const take = Math.min(size - filled, input.length - at)
      buffer.set(input.subarray(at, at + take), filled)
      filled += take; at += take
      if (filled === size) { onWindow(buffer, offset); offset += seconds; buffer = new Float32Array(size); filled = 0 }
    }
  }
  source.connect(node)
  node.connect(context.destination)
  return () => { node.disconnect(); source.disconnect(); void context.close() }
}

/** Transcribes samples in a background worker; `onProgress` gets 0..1. */
export function transcribe(audio: Float32Array, model: ModelId, onProgress: (done: number) => void): Promise<Segment[]> {
  const setup = workerSetup(model)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ progress?: number; segments?: Segment[]; error?: string }>) => {
      if (typeof e.data.progress === 'number') onProgress(e.data.progress)
      if (e.data.segments) { worker.terminate(); resolve(e.data.segments) }
      if (e.data.error) { worker.terminate(); reject(new Error(e.data.error)) }
    }
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'Transcription stopped')) }
    worker.postMessage({ audio, ...setup }, [audio.buffer])
  })
}

/** A course's word list: words written as the course writes them ("Kirchhoff", "MOSFET"), and
 *  fixes for what's misheard ("kirk off => Kirchhoff"). Kept in its settings as `words`. */
export type WordFix = { heard: RegExp; written: string }
export function wordFixes(raw: unknown): WordFix[] {
  if (!Array.isArray(raw)) return []
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return raw.filter((w): w is string => typeof w === 'string' && !!w.trim()).slice(0, 500).flatMap(w => {
    const [heard, written] = w.includes('=>') ? w.split('=>').map(x => x.trim()) : [w.trim(), w.trim()]
    return heard && written ? [{ heard: new RegExp(`(?<![\\w])${escape(heard)}(?![\\w])`, 'gi'), written }] : []
  })
}

/** The transcript with the course's words written its way. */
export function correctWords(segments: Segment[], fixes: WordFix[]): Segment[] {
  if (!fixes.length) return segments
  return segments.map(s => ({ ...s, text: fixes.reduce((text, f) => text.replace(f.heard, f.written), s.text) }))
}

/** The dated note for a lecture: a place to write what you remember first (recall before
 *  re-reading), room for a summary, and the transcript with times that play the recording. */
export function lectureNoteMarkdown(started: Date, length: string, segments: Segment[], link: (seconds: number) => string) {
  return [
    `Recorded ${started.toLocaleString()} · about ${length} · [play](${link(0)})`,
    '',
    '## Brain dump',
    '',
    '_Before reading the transcript: write down everything you remember from the class._',
    '',
    '## Summary',
    '',
    '_Ask Mimir to summarise it, or write your own._',
    '',
    transcriptMarkdown(segments, '## Transcript', link),
  ].join('\n')
}
