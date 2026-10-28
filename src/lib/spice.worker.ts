/// <reference lib="webworker" />
// ngspice (EEcircuit's WebAssembly build) off the main thread: one simulator, a netlist at a time.
import { Simulation, type ResultType } from 'eecircuit-engine'

export type SpiceRequest = { id: number; netlist: string }
export type SpiceReply = { id: number; result: ResultType | null; messages: string[]; error?: string }

let sim: Simulation | null = null
let queue: Promise<unknown> = Promise.resolve()

self.onmessage = (event: MessageEvent<SpiceRequest>) => {
  const { id, netlist } = event.data
  // ngspice runs one circuit at a time.
  queue = queue.then(async () => {
    try {
      if (!sim) { sim = new Simulation(); await sim.start() }
      sim.setNetList(netlist)
      const result = await sim.runSim()
      ;(self as unknown as Worker).postMessage({ id, result, messages: sim.getError() } satisfies SpiceReply)
    } catch (e) {
      ;(self as unknown as Worker).postMessage({ id, result: null, messages: sim?.getError() ?? [], error: e instanceof Error ? e.message : String(e) } satisfies SpiceReply)
    }
  })
}
