/// <reference lib="webworker" />
// The CAD kernel, off the main thread: OpenCascade (WebAssembly) through replicad. It builds a
// model's parts, sends back their triangles and edges to draw, and keeps the shapes for exports.
import opencascade from 'replicad-opencascadejs'
// The kernel's 22 MB of WebAssembly, bundled with the app (never fetched from the internet).
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import * as replicad from 'replicad'
import { kernelError, loadModel, partsOf, type Part } from './model'

type Shape = replicad.AnyShape
export type MeshedPart = { name: string; color: string; faces: ReturnType<replicad.Solid['mesh']>; edges: ReturnType<replicad.Solid['meshEdges']>; box: [number[], number[]] }
export type CadRequest =
  | { id: number; type: 'build'; code: string; params: Record<string, unknown> | null }
  | { id: number; type: 'export'; kind: 'stl' | 'step' }
export type CadReply =
  | { id: number; type: 'built'; parts: MeshedPart[]; defaults: Record<string, unknown>; ms: number }
  | { id: number; type: 'exported'; bytes: ArrayBuffer }
  | { id: number; type: 'error'; message: string }

let ready: Promise<void> | null = null
let last: Part<Shape>[] = []

function start() {
  ready ??= (async () => {
    const OC = await (opencascade as unknown as (o: object) => Promise<unknown>)({ locateFile: () => wasmUrl, print: () => undefined, printErr: () => undefined })
    replicad.setOC(OC as Parameters<typeof replicad.setOC>[0])
  })()
  return ready
}

const isShape = (x: unknown): x is Shape => !!x && typeof (x as { mesh?: unknown }).mesh === 'function'

self.onmessage = async (event: MessageEvent<CadRequest>) => {
  const req = event.data
  const reply = (r: CadReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer)
  try {
    await start()
    if (req.type === 'build') {
      const t = performance.now()
      const { defaults, main } = loadModel(req.code)
      const parts = partsOf(main(replicad, { ...defaults, ...(req.params ?? {}) }), isShape)
      // The old shapes' memory in the kernel is given back.
      for (const p of last) if (!parts.some(n => n.shape === p.shape)) (p.shape as { delete?: () => void }).delete?.()
      last = parts
      const meshed = parts.map(p => {
        const s = p.shape as replicad.Solid
        const b = s.boundingBox
        return { name: p.name, color: p.color, faces: s.mesh({ tolerance: 0.05, angularTolerance: 15 }), edges: s.meshEdges({ tolerance: 0.05, angularTolerance: 15 }), box: [b.bounds[0] as number[], b.bounds[1] as number[]] as [number[], number[]] }
      })
      reply({ id: req.id, type: 'built', parts: meshed, defaults, ms: Math.round(performance.now() - t) })
    } else {
      if (!last.length) throw new Error('Build the model first.')
      const shape = last.length === 1 ? last[0].shape : replicad.makeCompound(last.map(p => p.shape))
      const blob = req.kind === 'stl' ? (shape as replicad.Solid).blobSTL({ tolerance: 0.01, angularTolerance: 10, binary: true }) : (shape as replicad.Solid).blobSTEP()
      const bytes = await blob.arrayBuffer()
      reply({ id: req.id, type: 'exported', bytes }, [bytes])
    }
  } catch (e) {
    reply({ id: req.id, type: 'error', message: kernelError(e) })
  }
}
