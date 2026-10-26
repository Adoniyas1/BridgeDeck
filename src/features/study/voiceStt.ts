import { isTauri, modelsStatus } from '../../lib/bridge'
import { workerSetup, type ModelId } from './lecture'

/**
 * Speech to text for Mimir's voice (its Talk view, Open Mic, the wake word) when Mimir runs inside
 * BridgeDeck: the clips go to the same Whisper model lectures use, so the computer holds one copy
 * instead of two. The worker stays loaded while Mimir is being talked to, and goes after two quiet
 * minutes. Without a downloaded model this says so (null) and Mimir uses its own.
 */

const IDLE_MS = 2 * 60_000

let worker: Worker | null = null
let workerModel: ModelId | null = null
let idle = 0
let chain: Promise<unknown> = Promise.resolve()

/** The downloaded model to use (the fast one first: voice wants quick answers), or null. */
async function pickModel(): Promise<ModelId | null> {
  if (!isTauri()) return null
  const status = await modelsStatus().catch(() => null)
  if (!status?.engine) return null
  return (['fast', 'better'] as const).find(m => status.models.includes(m)) ?? null
}

function stop() {
  worker?.terminate()
  worker = null
  workerModel = null
}

function keepWarm() {
  window.clearTimeout(idle)
  idle = window.setTimeout(stop, IDLE_MS)
}

function ensureWorker(model: ModelId): Worker {
  if (worker && workerModel === model) return worker
  stop()
  worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
  workerModel = model
  worker.postMessage({ live: true, ...workerSetup(model) })
  return worker
}

/** Loads the model ahead of the first clip. False when there's no model here. */
export async function warmVoice(): Promise<boolean> {
  const model = await pickModel()
  if (!model) return false
  ensureWorker(model)
  keepWarm()
  return true
}

/** The text of a short clip (16 kHz mono), or null when there's no model here to do it. */
export function transcribeVoice(samples: Float32Array): Promise<string | null> {
  const run = async () => {
    const model = await pickModel()
    if (!model) return null
    const w = ensureWorker(model)
    keepWarm()
    const segments = await new Promise<Array<{ text: string }>>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<{ live?: Array<{ text: string }>; error?: string }>) => {
        if (e.data.error) reject(new Error(e.data.error))
        else if (e.data.live) resolve(e.data.live)
      }
      w.onerror = e => { stop(); reject(new Error(e.message || 'Speech to text stopped')) }
      w.postMessage({ window: samples, offset: 0 }, [samples.buffer])
    })
    keepWarm()
    return segments.map(s => s.text).join(' ').trim()
  }
  // One clip at a time through the one worker.
  const next = chain.then(run, run)
  chain = next.catch(() => undefined)
  return next
}
