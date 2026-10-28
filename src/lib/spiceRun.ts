import type { SpiceReply } from './spice.worker'
import { problems, readResult, toNgspice, type SpiceResult } from './spice'

/** ngspice in a worker, started the first time a circuit needs it (about half a second). */
let worker: Worker | null = null
let next = 1
const waiting = new Map<number, (r: SpiceReply) => void>()

export async function simulate(text: string): Promise<{ result: SpiceResult | null; problems: string[] }> {
  if (!worker) {
    worker = new Worker(new URL('./spice.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<SpiceReply>) => { waiting.get(e.data.id)?.(e.data); waiting.delete(e.data.id) }
    worker.onerror = e => { for (const [id, done] of waiting) done({ id, result: null, messages: [], error: e.message || 'The simulator stopped.' }); waiting.clear(); worker?.terminate(); worker = null }
  }
  const id = next++
  const reply = await new Promise<SpiceReply>(resolve => { waiting.set(id, resolve); worker!.postMessage({ id, netlist: toNgspice(text) }) })
  const found = problems(reply.messages)
  // ngspice loads its engine from inside its own file; a web view that applies the window's
  // security policy to workers won't let it.
  if (reply.error && /Content Security Policy|Refused to connect|failed to asynchronously prepare wasm/i.test(reply.error)) return { result: null, problems: ['This computer’s web view won’t start ngspice (its security policy blocks it). Use “Report a problem” in Settings → About so it can be fixed.'] }
  if (reply.error) return { result: null, problems: [reply.error, ...found] }
  if (!reply.result || !reply.result.data?.length) return { result: null, problems: found.length ? found : ['ngspice gave nothing back: add an analysis such as .tran 10u 5m, .ac dec 20 10 100k or .op.'] }
  return { result: readResult(reply.result), problems: found }
}
