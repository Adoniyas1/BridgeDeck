/** Gate delays: what happens in the nanoseconds after one switch flips, gate by gate, with each gate
 *  taking its real time to answer (typical 74LS delays). Different paths take different times, so an
 *  output can flicker before it settles: a glitch (a hazard). The steady-state simulation can't show
 *  that; this can. */
import { chipDef, gateValue, nets, partNames, pinRef, simulate, type Circuit, type GateType, type Level } from './model'

/** Typical 74LS propagation delays, in nanoseconds. */
export const DELAY: Record<GateType, number> = { NOT: 10, BUF: 10, NAND: 10, NOR: 10, AND: 15, OR: 15, XOR: 20, XNOR: 20 }

type Driver = { name: string; type: GateType; ins: string[]; out: string; delay: number }
export type Wave = { name: string; kind: 'in' | 'out' | 'gate'; changes: Array<{ t: number; v: Level }> }
export type Glitch = { name: string; from: number; to: number; kind: 'static' | 'dynamic' }
export type DelayRun = { waves: Wave[]; end: number; settled: number; glitches: Glitch[]; flipAt: number }

/** Flips switch `label` at `flipAt` ns (from where the switches are now) and follows every gate. */
export function delayRun(c: Circuit, label: string, opts: { flipAt?: number; until?: number; delays?: Partial<Record<GateType, number>> } = {}): DelayRun {
  const flipAt = opts.flipAt ?? 10
  const until = opts.until ?? 400
  const delays = { ...DELAY, ...opts.delays }
  const netOf = nets(c)
  const names = partNames(c)
  const net = (ref: string) => netOf.get(ref) ?? ref
  // The gates (on their own, or inside 74-series chips), each reading nets and driving one.
  const drivers: Driver[] = []
  for (const p of c.parts) {
    if (p.kind === 'gate') {
      const n = p.gate === 'NOT' || p.gate === 'BUF' ? 1 : p.inputs ?? 2
      const type = p.gate ?? 'AND'
      drivers.push({ name: names[p.id], type, ins: Array.from({ length: n }, (_, i) => net(pinRef(p, `in${i}`))), out: net(pinRef(p, 'out')), delay: delays[type] })
    }
    const def = p.kind === 'chip' ? chipDef(p.chip) : undefined
    def?.gates.forEach((g, i) => drivers.push({ name: `${names[p.id]} gate ${i + 1}`, type: g.type, ins: g.ins.map(pin => net(pinRef(p, String(pin)))), out: net(pinRef(p, String(g.out))), delay: delays[g.type] }))
  }
  // Start from the steady state with the switches as they are.
  const start = simulate(c).pins
  const value = new Map<string, Level>()
  for (const [ref, v] of Object.entries(start)) value.set(net(ref), v)
  const sw = c.parts.find(p => p.kind === 'switch' && p.label === label)
  const history = new Map<string, Array<{ t: number; v: Level }>>()
  const record = (n: string, t: number, v: Level) => { const h = history.get(n) ?? [{ t: 0, v: value.get(n) ?? null }]; if (h[h.length - 1].v !== v) h.push({ t, v }); history.set(n, h) }
  for (const n of value.keys()) history.set(n, [{ t: 0, v: value.get(n) ?? null }])
  // Events: (time, net, value), applied in time order; each change re-evaluates the gates reading it
  // and schedules their outputs a gate delay later (transport delay, so short pulses get through).
  const queue: Array<{ t: number; n: string; v: Level }> = []
  const push = (e: { t: number; n: string; v: Level }) => { let i = queue.length; while (i > 0 && queue[i - 1].t > e.t) i--; queue.splice(i, 0, e) }
  const readers = new Map<string, Driver[]>()
  for (const d of drivers) for (const n of d.ins) readers.set(n, [...(readers.get(n) ?? []), d])
  if (sw) push({ t: flipAt, n: net(pinRef(sw, 'out')), v: sw.on ? 0 : 1 })
  let settled = flipAt
  let steps = 0
  while (queue.length && steps++ < 20000) {
    const e = queue.shift()!
    if (e.t > until) break
    if (value.get(e.n) === e.v) continue
    value.set(e.n, e.v)
    record(e.n, e.t, e.v)
    settled = e.t
    for (const d of readers.get(e.n) ?? []) push({ t: e.t + d.delay, n: d.out, v: gateValue(d.type, d.ins.map(n => value.get(n) ?? null)) })
  }
  const end = Math.max(flipAt * 2, Math.ceil((settled + 20) / 10) * 10)
  const wave = (name: string, kind: Wave['kind'], n: string): Wave => ({ name, kind, changes: history.get(n) ?? [{ t: 0, v: value.get(n) ?? null }] })
  const waves: Wave[] = [
    ...(sw ? [wave(label, 'in', net(pinRef(sw, 'out')))] : []),
    ...drivers.map(d => wave(d.name, 'gate', d.out)),
    ...c.parts.filter(p => p.kind === 'led').sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '')).map(p => wave(p.label ?? 'LED', 'out', net(pinRef(p, 'in')))),
  ]
  // A glitch: an output that changed more than its start and end values call for.
  const glitches: Glitch[] = []
  for (const w of waves.filter(x => x.kind === 'out')) {
    const after = w.changes.filter(ch => ch.t > 0)
    if (!after.length) continue
    const first = w.changes[0].v, last = w.changes[w.changes.length - 1].v
    if (first === last) glitches.push({ name: w.name, from: after[0].t, to: after[after.length - 1].t, kind: 'static' })
    else if (after.length > 1) glitches.push({ name: w.name, from: after[0].t, to: after[after.length - 1].t, kind: 'dynamic' })
  }
  return { waves, end, settled, glitches, flipAt }
}

/** A wave's level at time t. */
export function levelAt(w: Wave, t: number): Level {
  let v = w.changes[0]?.v ?? null
  for (const ch of w.changes) { if (ch.t <= t) v = ch.v; else break }
  return v
}
