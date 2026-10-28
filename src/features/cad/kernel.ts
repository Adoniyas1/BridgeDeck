import type { CadReply, CadRequest, MeshedPart } from './cad.worker'

/** The CAD worker, started the first time a model is built (its kernel is 22 MB of WebAssembly). A
 *  newer build makes an older one's answer moot, so only the latest build's parts are kept. */
let worker: Worker | null = null
let next = 1
const waiting = new Map<number, { resolve: (r: CadReply) => void }>()

type Body<T> = T extends unknown ? Omit<T, 'id'> : never
function ask(req: Body<CadRequest>): Promise<CadReply> {
  if (!worker) {
    worker = new Worker(new URL('./cad.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<CadReply>) => { waiting.get(e.data.id)?.resolve(e.data); waiting.delete(e.data.id) }
    worker.onerror = e => { for (const [id, w] of waiting) w.resolve({ id, type: 'error', message: e.message || 'The CAD kernel stopped.' }); waiting.clear(); worker?.terminate(); worker = null }
  }
  const id = next++
  return new Promise(resolve => { waiting.set(id, { resolve }); worker!.postMessage({ ...req, id }) })
}

export type Built = { parts: MeshedPart[]; defaults: Record<string, unknown>; ms: number }

export async function build(code: string, params: Record<string, unknown> | null): Promise<Built> {
  const r = await ask({ type: 'build', code, params })
  if (r.type === 'error') throw new Error(r.message)
  if (r.type !== 'built') throw new Error('Unexpected answer from the CAD kernel')
  return r
}

export async function exportModel(kind: 'stl' | 'step'): Promise<Uint8Array> {
  const r = await ask({ type: 'export', kind })
  if (r.type === 'error') throw new Error(r.message)
  if (r.type !== 'exported') throw new Error('Unexpected answer from the CAD kernel')
  return new Uint8Array(r.bytes)
}
