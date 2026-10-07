/** Logic circuits: parts, the 74-series chips, simulation, truth tables, expressions and chip plans. */

export type Level = 0 | 1 | null
export type GateType = 'AND' | 'OR' | 'NOT' | 'NAND' | 'NOR' | 'XOR' | 'XNOR' | 'BUF'
export type PartKind = 'switch' | 'clock' | 'led' | 'vcc' | 'gnd' | 'gate' | 'chip' | 'seg7'

export type Part = {
  id: string
  kind: PartKind
  x: number
  y: number
  gate?: GateType
  inputs?: number
  chip?: string
  /** Switch, clock and LED names (A, B… X, Y…). */
  label?: string
  /** A switch's position; for a 7-segment display, common anode (a segment lights on 0, as from a 7447). */
  on?: boolean
}
/** A wire between two pins, written "partId:pin". */
export type Wire = { id: string; a: string; b: string }
export type Circuit = { version: 1; parts: Part[]; wires: Wire[] }

export const GATES: GateType[] = ['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR', 'XNOR', 'BUF']

// ---- The chips ----

type ChipGate = { type: GateType; ins: number[]; out: number }
type ChipFlop = { d: number; clk: number; pre: number; clr: number; q: number; nq: number }
/** A chip that isn't gates or flip-flops (decoders, multiplexers, counters): its input and output
 *  pins, its outputs from its inputs and stored value, and for a counter what a rising clock edge
 *  (`edge`) or an asynchronous input (`now`, e.g. clear) does to the stored value. */
type PinLevel = (pin: number) => Level
type ChipLogic = { ins: number[]; outs: number[]; out: (pin: PinLevel, n: number) => Record<number, Level>; clk?: number; edge?: (pin: PinLevel, n: number) => number; now?: (pin: PinLevel) => number | null }
export type ChipDef = { part: string; name: string; pins: number; vcc: number; gnd: number; gates: ChipGate[]; flops?: ChipFlop[]; logic?: ChipLogic; labels: Record<number, string> }

const quad = (type: GateType, layout: 'standard' | 'nor' | 'xnor'): ChipGate[] => {
  if (layout === 'nor') return [{ type, ins: [2, 3], out: 1 }, { type, ins: [5, 6], out: 4 }, { type, ins: [8, 9], out: 10 }, { type, ins: [11, 12], out: 13 }]
  if (layout === 'xnor') return [{ type, ins: [1, 2], out: 3 }, { type, ins: [5, 6], out: 4 }, { type, ins: [8, 9], out: 10 }, { type, ins: [12, 13], out: 11 }]
  return [{ type, ins: [1, 2], out: 3 }, { type, ins: [4, 5], out: 6 }, { type, ins: [9, 10], out: 8 }, { type, ins: [12, 13], out: 11 }]
}
const triple = (type: GateType): ChipGate[] => [{ type, ins: [1, 2, 13], out: 12 }, { type, ins: [3, 4, 5], out: 6 }, { type, ins: [9, 10, 11], out: 8 }]
const dual4 = (type: GateType): ChipGate[] => [{ type, ins: [1, 2, 4, 5], out: 6 }, { type, ins: [9, 10, 12, 13], out: 8 }]

/** Pin names from the gates (1A, 1B, 1Y…), plus power. */
function labelsFor(gates: ChipGate[], flops: ChipFlop[] = []): Record<number, string> {
  const out: Record<number, string> = { 7: 'GND', 14: 'VCC' }
  gates.forEach((g, i) => {
    g.ins.forEach((p, j) => { out[p] = `${i + 1}${'ABCD'[j]}` })
    out[g.out] = `${i + 1}Y`
  })
  flops.forEach((f, i) => {
    const n = i + 1
    Object.assign(out, { [f.d]: `${n}D`, [f.clk]: `${n}CLK`, [f.pre]: `${n}PRE̅`, [f.clr]: `${n}CLR̅`, [f.q]: `${n}Q`, [f.nq]: `${n}Q̅` })
  })
  return out
}

function chip(part: string, name: string, gates: ChipGate[], flops?: ChipFlop[]): ChipDef {
  return { part, name, pins: 14, vcc: 14, gnd: 7, gates, flops, labels: labelsFor(gates, flops) }
}

/** The 74-series chips (DIP-14, pin 14 to +5 V, pin 7 to ground), pinouts as in the datasheets. */
export const CHIPS: ChipDef[] = [
  chip('7400', 'Quad 2-input NAND', quad('NAND', 'standard')),
  chip('7402', 'Quad 2-input NOR', quad('NOR', 'nor')),
  chip('7404', 'Hex inverter (NOT)', [{ type: 'NOT', ins: [1], out: 2 }, { type: 'NOT', ins: [3], out: 4 }, { type: 'NOT', ins: [5], out: 6 }, { type: 'NOT', ins: [9], out: 8 }, { type: 'NOT', ins: [11], out: 10 }, { type: 'NOT', ins: [13], out: 12 }]),
  chip('7408', 'Quad 2-input AND', quad('AND', 'standard')),
  chip('7410', 'Triple 3-input NAND', triple('NAND')),
  chip('7411', 'Triple 3-input AND', triple('AND')),
  chip('7420', 'Dual 4-input NAND', dual4('NAND')),
  chip('7421', 'Dual 4-input AND', dual4('AND')),
  chip('7427', 'Triple 3-input NOR', triple('NOR')),
  chip('7432', 'Quad 2-input OR', quad('OR', 'standard')),
  chip('7486', 'Quad 2-input XOR', quad('XOR', 'standard')),
  chip('74266', 'Quad 2-input XNOR', quad('XNOR', 'xnor')),
  chip('7474', 'Dual D flip-flop (rising edge)', [], [{ clr: 1, d: 2, clk: 3, pre: 4, q: 5, nq: 6 }, { clr: 13, d: 12, clk: 11, pre: 10, q: 9, nq: 8 }]),
]

// ---- 16-pin chips (pin 16 to +5 V, pin 8 to ground) ----

/** Control inputs left unconnected float high on TTL chips. */
const high = (v: Level): 0 | 1 => (v === 0 ? 0 : 1)
const bits = (pin: PinLevel, pins: number[]): number | null => {
  let n = 0
  for (const [i, p] of pins.entries()) { const v = pin(p); if (v === null) return null; n |= v << i }
  return n
}
const allOf = (pins: number[], v: Level) => Object.fromEntries(pins.map(p => [p, v]))

/** Segments lit for each value on a 7447 (a–g), including its odd shapes for 10–15. */
export const SEGMENTS_7447 = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'cdefg', 'abc', 'abcdefg', 'abcfg', 'deg', 'cdg', 'bfg', 'adfg', 'defg', '']
const SEG_PINS_7447: Record<string, number> = { a: 13, b: 12, c: 11, d: 10, e: 9, f: 15, g: 14 }

function chip16(part: string, name: string, labels: Record<number, string>, logic: ChipLogic): ChipDef {
  return { part, name, pins: 16, vcc: 16, gnd: 8, gates: [], logic, labels: { ...labels, 8: 'GND', 16: 'VCC' } }
}

CHIPS.push(
  chip16('7447', 'BCD to 7-segment decoder (outputs low = lit)', { 7: 'A', 1: 'B', 2: 'C', 6: 'D', 3: 'LT̅', 4: 'BI̅', 5: 'RBI̅', 13: 'a̅', 12: 'b̅', 11: 'c̅', 10: 'd̅', 9: 'e̅', 15: 'f̅', 14: 'g̅' }, {
    ins: [7, 1, 2, 6, 3, 4, 5], outs: Object.values(SEG_PINS_7447),
    out: pin => {
      const outs = Object.values(SEG_PINS_7447)
      if (high(pin(4)) === 0) return allOf(outs, 1)
      if (high(pin(3)) === 0) return allOf(outs, 0)
      const n = bits(pin, [7, 1, 2, 6])
      if (n === null) return allOf(outs, null)
      const lit = n === 0 && high(pin(5)) === 0 ? '' : SEGMENTS_7447[n]
      return Object.fromEntries(Object.entries(SEG_PINS_7447).map(([seg, p]) => [p, lit.includes(seg) ? 0 : 1]))
    },
  }),
  chip16('74138', '3-to-8 line decoder (outputs active low)', { 1: 'A', 2: 'B', 3: 'C', 4: 'G2A̅', 5: 'G2B̅', 6: 'G1', 15: 'Y0̅', 14: 'Y1̅', 13: 'Y2̅', 12: 'Y3̅', 11: 'Y4̅', 10: 'Y5̅', 9: 'Y6̅', 7: 'Y7̅' }, {
    ins: [1, 2, 3, 4, 5, 6], outs: [15, 14, 13, 12, 11, 10, 9, 7],
    out: pin => {
      const outs = [15, 14, 13, 12, 11, 10, 9, 7]
      if (high(pin(6)) === 0 || high(pin(4)) === 1 || high(pin(5)) === 1) return allOf(outs, 1)
      const n = bits(pin, [1, 2, 3])
      return n === null ? allOf(outs, null) : Object.fromEntries(outs.map((p, i) => [p, i === n ? 0 : 1]))
    },
  }),
  chip16('74151', '8-to-1 multiplexer', { 4: 'D0', 3: 'D1', 2: 'D2', 1: 'D3', 15: 'D4', 14: 'D5', 13: 'D6', 12: 'D7', 11: 'A', 10: 'B', 9: 'C', 7: 'G̅', 5: 'Y', 6: 'W' }, {
    ins: [4, 3, 2, 1, 15, 14, 13, 12, 11, 10, 9, 7], outs: [5, 6],
    out: pin => {
      if (high(pin(7)) === 1) return { 5: 0, 6: 1 }
      const n = bits(pin, [11, 10, 9])
      const v = n === null ? null : pin([4, 3, 2, 1, 15, 14, 13, 12][n])
      return { 5: v, 6: v === null ? null : v ? 0 : 1 }
    },
  }),
  chip16('74161', '4-bit binary counter (sync load, async clear)', { 1: 'CLR̅', 2: 'CLK', 3: 'A', 4: 'B', 5: 'C', 6: 'D', 7: 'ENP', 9: 'LOAD̅', 10: 'ENT', 15: 'QA', 14: 'QB', 13: 'QC', 12: 'QD', 11: 'RCO' }, {
    ins: [1, 2, 3, 4, 5, 6, 7, 9, 10], outs: [15, 14, 13, 12, 11], clk: 2,
    out: (pin, n) => ({ 15: n & 1 ? 1 : 0, 14: n & 2 ? 1 : 0, 13: n & 4 ? 1 : 0, 12: n & 8 ? 1 : 0, 11: n === 15 && high(pin(10)) === 1 ? 1 : 0 }),
    now: pin => (high(pin(1)) === 0 ? 0 : null),
    edge: (pin, n) => {
      if (high(pin(9)) === 0) return bits(pin, [3, 4, 5, 6]) ?? n
      return high(pin(7)) === 1 && high(pin(10)) === 1 ? (n + 1) % 16 : n
    },
  }),
)

export const chipDef = (part?: string) => CHIPS.find(c => c.part === part)

// ---- Shapes and pins ----

export type PinDir = 'in' | 'out' | 'power' | 'nc'
export type PinDef = { name: string; x: number; y: number; dir: PinDir; label?: string }

export const GRID = 10

export function gateHeight(inputs: number) {
  return Math.max(40, inputs * 20)
}

/** A part's size (its body, pins stick out beyond it). */
export function sizeOf(part: Part): { w: number; h: number } {
  switch (part.kind) {
    case 'gate': return { w: 60, h: gateHeight(part.gate === 'NOT' || part.gate === 'BUF' ? 1 : part.inputs ?? 2) }
    case 'chip': { const n = chipDef(part.chip)?.pins ?? 14; return { w: (n / 2) * 20 + 20, h: 60 } }
    case 'led': return { w: 40, h: 40 }
    case 'seg7': return { w: 60, h: 90 }
    default: return { w: 40, h: 40 }
  }
}

/** A part's pins, relative to its top-left corner. */
export function pinsOf(part: Part): PinDef[] {
  const { w, h } = sizeOf(part)
  switch (part.kind) {
    case 'switch': case 'clock': case 'vcc': case 'gnd': return [{ name: 'out', x: w + 10, y: h / 2, dir: 'out' }]
    case 'led': return [{ name: 'in', x: -10, y: h / 2, dir: 'in' }]
    case 'seg7': return SEG7_PINS.map((name, i) => ({ name, x: -10, y: 10 + i * 11.5, dir: 'in' as const, label: name }))
    case 'gate': {
      const n = part.gate === 'NOT' || part.gate === 'BUF' ? 1 : part.inputs ?? 2
      const ins: PinDef[] = Array.from({ length: n }, (_, i) => ({ name: `in${i}`, x: -10, y: n === 1 ? h / 2 : 10 + i * ((h - 20) / (n - 1)), dir: 'in' }))
      return [...ins, { name: 'out', x: w + 10, y: h / 2, dir: 'out' }]
    }
    case 'chip': {
      const def = chipDef(part.chip)
      if (!def) return []
      const half = def.pins / 2
      const dirOf = (p: number): PinDir => {
        if (p === def.vcc || p === def.gnd) return 'power'
        if (def.gates.some(g => g.out === p) || def.flops?.some(f => f.q === p || f.nq === p) || def.logic?.outs.includes(p)) return 'out'
        if (def.gates.some(g => g.ins.includes(p)) || def.flops?.some(f => [f.d, f.clk, f.pre, f.clr].includes(p)) || def.logic?.ins.includes(p)) return 'in'
        return 'nc'
      }
      return Array.from({ length: def.pins }, (_, i) => {
        const p = i + 1
        // Seen from above, notch on the left: pins 1… along the bottom, then back along the top.
        const x = p <= half ? 20 + (p - 1) * 20 : 20 + (def.pins - p) * 20
        return { name: String(p), x, y: p <= half ? h + 10 : -10, dir: dirOf(p), label: def.labels[p] }
      })
    }
  }
}

/** A 7-segment display's inputs, top to bottom. */
export const SEG7_PINS = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

export const pinRef = (part: Part, pin: string) => `${part.id}:${pin}`

/** Where a pin is on the canvas. */
export function pinPoint(part: Part, pin: string): { x: number; y: number } | null {
  const def = pinsOf(part).find(p => p.name === pin)
  return def ? { x: part.x + def.x, y: part.y + def.y } : null
}

// ---- Simulation ----

function gateValue(type: GateType, ins: Level[]): Level {
  const any = (v: 0 | 1) => ins.includes(v)
  const unknown = ins.includes(null)
  const inv = (v: Level): Level => (v === null ? null : v ? 0 : 1)
  switch (type) {
    case 'BUF': return ins[0] ?? null
    case 'NOT': return inv(ins[0] ?? null)
    case 'AND': return any(0) ? 0 : unknown ? null : 1
    case 'NAND': return inv(gateValue('AND', ins))
    case 'OR': return any(1) ? 1 : unknown ? null : 0
    case 'NOR': return inv(gateValue('OR', ins))
    case 'XOR': return unknown ? null : (ins.filter(v => v === 1).length % 2 ? 1 : 0)
    case 'XNOR': return inv(gateValue('XOR', ins))
  }
}

/** Flip-flop memory kept between simulation steps: last clock level and Q, by "partId:index". */
export type FlopState = Record<string, { clk: Level; q: 0 | 1; n?: number }>

export type Sim = {
  /** Each pin's level. */
  pins: Record<string, Level>
  /** Wires carrying two different levels at once (a short), by wire id. */
  shorts: string[]
  warnings: string[]
  state: FlopState
}

/** Union-find over pins joined by wires: each pin's net. */
export function nets(c: Circuit): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = parent.get(x) ?? x
    while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r
    parent.set(x, r)
    return r
  }
  for (const part of c.parts) for (const pin of pinsOf(part)) parent.set(pinRef(part, pin.name), pinRef(part, pin.name))
  for (const w of c.wires) {
    if (!parent.has(w.a) || !parent.has(w.b)) continue
    const a = find(w.a), b = find(w.b)
    if (a !== b) parent.set(a, b)
  }
  const out = new Map<string, string>()
  for (const key of parent.keys()) out.set(key, find(key))
  return out
}

export function simulate(c: Circuit, opts: { clock?: boolean; state?: FlopState } = {}): Sim {
  const netOf = nets(c)
  const wired = new Set<string>()
  for (const w of c.wires) { wired.add(w.a); wired.add(w.b) }
  const state: FlopState = JSON.parse(JSON.stringify(opts.state ?? {}))
  const names = partNames(c)
  const warnings = new Set<string>()
  // What each output pin drives, and each net's level ('X': two drivers disagree).
  const drive = new Map<string, Level>()
  const netLevel = new Map<string, Level | 'X'>()
  const level = (ref: string): Level => { const v = netLevel.get(netOf.get(ref) ?? ref); return v === 'X' || v === undefined ? null : v }
  const flopKey = (part: Part, i: number) => `${part.id}:${i}`

  /** Recomputes outputs from inputs until nothing changes. Flip-flops show their stored Q. */
  const settle = () => {
    for (let round = 0; round < 100; round++) {
      netLevel.clear()
      for (const [ref, v] of drive) {
        const net = netOf.get(ref) ?? ref
        if (v === null) { if (!netLevel.has(net)) netLevel.set(net, null); continue }
        const before = netLevel.get(net)
        netLevel.set(net, before === undefined || before === null ? v : before === v ? v : 'X')
      }
      let changed = false
      const set = (ref: string, v: Level) => { if (!drive.has(ref) || drive.get(ref) !== v) { changed = true; drive.set(ref, v) } }
      for (const part of c.parts) {
        const ref = (pin: string | number) => pinRef(part, String(pin))
        switch (part.kind) {
          case 'switch': set(ref('out'), part.on ? 1 : 0); break
          case 'clock': set(ref('out'), opts.clock ? 1 : 0); break
          case 'vcc': set(ref('out'), 1); break
          case 'gnd': set(ref('out'), 0); break
          case 'gate': {
            const n = part.gate === 'NOT' || part.gate === 'BUF' ? 1 : part.inputs ?? 2
            set(ref('out'), gateValue(part.gate ?? 'AND', Array.from({ length: n }, (_, i) => level(ref(`in${i}`)))))
            break
          }
          case 'chip': {
            const def = chipDef(part.chip)
            if (!def) break
            const powered = level(ref(def.vcc)) === 1 && level(ref(def.gnd)) === 0
            if (!powered) {
              def.gates.forEach(g => set(ref(g.out), null))
              def.flops?.forEach(f => { set(ref(f.q), null); set(ref(f.nq), null) })
              def.logic?.outs.forEach(p => set(ref(p), null))
              break
            }
            if (def.logic) {
              const pin = (p: number) => level(ref(p))
              const key = `${part.id}:r`
              const now = def.logic.now?.(pin)
              if (now != null) state[key] = { clk: state[key]?.clk ?? null, q: 0, n: now }
              for (const [p, v] of Object.entries(def.logic.out(pin, state[key]?.n ?? 0))) set(ref(p), v)
            }
            for (const g of def.gates) set(ref(g.out), gateValue(g.type, g.ins.map(p => level(ref(p)))))
            def.flops?.forEach((f, i) => {
              const q = state[flopKey(part, i)]?.q ?? 0
              // Preset and clear act at once (active low; unwired they float high, as on the real chip).
              const pre = level(ref(f.pre)) ?? 1, clr = level(ref(f.clr)) ?? 1
              const [vq, vnq]: [Level, Level] = pre === 0 && clr === 0 ? [1, 1] : pre === 0 ? [1, 0] : clr === 0 ? [0, 1] : [q, q ? 0 : 1]
              set(ref(f.q), vq)
              set(ref(f.nq), vnq)
            })
            break
          }
          case 'led': case 'seg7': break
        }
      }
      if (!changed) return true
    }
    return false
  }

  let stable = settle()
  // Flip-flops take D on a rising clock edge (clock low last step, high now), then the rest settles.
  for (const part of c.parts) {
    const def = chipDef(part.chip)
    if (part.kind !== 'chip' || !def) continue
    const powered = level(pinRef(part, String(def.vcc))) === 1 && level(pinRef(part, String(def.gnd))) === 0
    if (def.logic?.clk && def.logic.edge) {
      const key = `${part.id}:r`
      const before = state[key] ?? { clk: null, q: 0, n: 0 }
      const pin = (p: number) => level(pinRef(part, String(p)))
      const clk = pin(def.logic.clk)
      const n = powered && before.clk === 0 && clk === 1 && def.logic.now?.(pin) == null ? def.logic.edge(pin, before.n ?? 0) : before.n ?? 0
      state[key] = { clk, q: 0, n }
      continue
    }
    if (!def.flops) continue
    def.flops.forEach((f, i) => {
      const key = flopKey(part, i)
      const before = state[key] ?? { clk: null, q: 0 }
      const clk = level(pinRef(part, String(f.clk))), d = level(pinRef(part, String(f.d)))
      const pre = level(pinRef(part, String(f.pre))) ?? 1, clr = level(pinRef(part, String(f.clr))) ?? 1
      let q = before.q
      if (pre === 0 && clr !== 0) q = 1
      else if (clr === 0 && pre !== 0) q = 0
      else if (powered && before.clk === 0 && clk === 1 && d !== null) q = d
      state[key] = { clk, q }
    })
  }
  if (c.parts.some(p => chipDef(p.chip)?.flops || chipDef(p.chip)?.logic?.clk)) stable = settle()
  if (!stable) warnings.add('The circuit keeps changing (it oscillates): a loop without a flip-flop.')

  for (const part of c.parts) {
    const def = chipDef(part.chip)
    if (part.kind !== 'chip' || !def) continue
    const used = pinsOf(part).some(p => wired.has(pinRef(part, p.name)))
    const powered = level(pinRef(part, String(def.vcc))) === 1 && level(pinRef(part, String(def.gnd))) === 0
    if (used && !powered) warnings.add(`${names[part.id]} (${def.part}) has no power: wire pin ${def.vcc} to VCC and pin ${def.gnd} to GND.`)
  }
  const pins: Record<string, Level> = {}
  for (const [ref, net] of netOf) {
    const v = netLevel.get(net)
    pins[ref] = v === 'X' || v === undefined ? null : v
  }
  const shortNets = new Set([...netLevel].filter(([, v]) => v === 'X').map(([n]) => n))
  if (shortNets.size) warnings.add('Two outputs are wired together and disagree (a short circuit): the red wires.')
  // Inputs with nothing driving them.
  const drivenNets = new Set([...drive.keys()].map(r => netOf.get(r)))
  for (const part of c.parts) {
    if (part.kind !== 'gate' && part.kind !== 'led' && part.kind !== 'seg7') continue
    if (part.kind === 'seg7' ? !pinsOf(part).some(pin => drivenNets.has(netOf.get(pinRef(part, pin.name)))) : pinsOf(part).some(pin => pin.dir === 'in' && !drivenNets.has(netOf.get(pinRef(part, pin.name))))) warnings.add(`${names[part.id]} has an input that isn't connected.`)
  }
  return { pins, shorts: c.wires.filter(w => shortNets.has(netOf.get(w.a) ?? '')).map(w => w.id), warnings: [...warnings], state }
}

/** Short names for parts: G1, G2… for gates, U1… for chips, labels for switches and LEDs. */
export function partNames(c: Circuit): Record<string, string> {
  const out: Record<string, string> = {}
  let g = 0, u = 0
  for (const p of c.parts) {
    if (p.kind === 'gate') out[p.id] = `${p.gate} gate G${++g}`
    else if (p.kind === 'chip') out[p.id] = `U${++u}`
    else out[p.id] = p.label || p.kind.toUpperCase()
  }
  return out
}

/** The next free label: A, B, C… for inputs, X, Y, Z, F1… for outputs. */
export function nextLabel(c: Circuit, kind: 'switch' | 'clock' | 'led'): string {
  const used = new Set(c.parts.map(p => p.label))
  const pool = kind === 'led' ? ['X', 'Y', 'Z', 'W', 'F', 'G', 'H'] : kind === 'clock' ? ['CLK', 'CLK2', 'CLK3'] : 'ABCDEFGHIJKLMNPQRSTUV'.split('')
  return pool.find(l => !used.has(l)) ?? `${kind === 'led' ? 'F' : 'I'}${c.parts.length}`
}

// ---- Truth tables ----

export type TruthTable = { inputs: string[]; outputs: string[]; rows: Array<{ in: Array<0 | 1>; out: Level[] }>; sequential: boolean; error?: string }

export const MAX_TABLE_INPUTS = 10

/** Every combination of the switches (A is the leftmost column, the most significant bit). */
export function truthTable(c: Circuit): TruthTable {
  const inputs = c.parts.filter(p => p.kind === 'switch').sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
  const outputs = c.parts.filter(p => p.kind === 'led').sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
  const sequential = c.parts.some(p => p.kind === 'clock' || chipDef(p.chip)?.flops?.length || chipDef(p.chip)?.logic?.clk)
  const table: TruthTable = { inputs: inputs.map(p => p.label ?? '?'), outputs: outputs.map(p => p.label ?? '?'), rows: [], sequential }
  if (inputs.length > MAX_TABLE_INPUTS) return { ...table, error: `More than ${MAX_TABLE_INPUTS} inputs: ${2 ** inputs.length} rows is too many to list.` }
  const n = inputs.length
  for (let row = 0; row < 2 ** n; row++) {
    const bits = inputs.map((_, i) => ((row >> (n - 1 - i)) & 1) as 0 | 1)
    const trial: Circuit = { ...c, parts: c.parts.map(p => { const i = inputs.findIndex(x => x.id === p.id); return i >= 0 ? { ...p, on: bits[i] === 1 } : p }) }
    const sim = simulate(trial)
    table.rows.push({ in: bits, out: outputs.map(o => sim.pins[pinRef(o, 'in')] ?? null) })
  }
  return table
}

// ---- Simplifying (Quine–McCluskey) ----

/** A product term: the bits outside `mask` must equal `value`. */
export type Implicant = { value: number; mask: number }

/** The groups (prime implicants) a smallest sum of products uses, in textbook order. Empty when
 *  the output is never 1; one group with every bit masked when it's always 1. */
export function implicants(n: number, minterms: number[], dontCares: number[] = []): Implicant[] {
  const ones = new Set(minterms)
  if (!ones.size) return []
  if (ones.size + new Set(dontCares.filter(d => !ones.has(d))).size === 2 ** n) return [{ value: 0, mask: 2 ** n - 1 }]
  let groups: Implicant[] = [...new Set([...minterms, ...dontCares])].map(v => ({ value: v, mask: 0 }))
  const primes: Implicant[] = []
  while (groups.length) {
    const used = new Set<number>()
    const next = new Map<string, Implicant>()
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i], b = groups[j]
        if (a.mask !== b.mask) continue
        const diff = a.value ^ b.value
        if (diff && (diff & (diff - 1)) === 0) {
          const merged = { value: a.value & ~diff, mask: a.mask | diff }
          next.set(`${merged.value}/${merged.mask}`, merged)
          used.add(i); used.add(j)
        }
      }
    }
    groups.forEach((g, i) => { if (!used.has(i) && !primes.some(p => p.value === g.value && p.mask === g.mask)) primes.push(g) })
    groups = [...next.values()]
  }
  const covers = (p: Implicant, m: number) => (m & ~p.mask) === p.value
  // Essential primes first, then the prime covering most of what's left.
  const left = new Set(minterms)
  const chosen: Implicant[] = []
  for (const m of minterms) {
    const by = primes.filter(p => covers(p, m))
    if (by.length === 1 && !chosen.includes(by[0])) chosen.push(by[0])
  }
  chosen.forEach(p => minterms.forEach(m => { if (covers(p, m)) left.delete(m) }))
  while (left.size) {
    const best = primes.filter(p => !chosen.includes(p)).sort((a, b) => [...left].filter(m => covers(b, m)).length - [...left].filter(m => covers(a, m)).length || bitCount(b.mask) - bitCount(a.mask))[0]
    if (!best) break
    chosen.push(best)
    for (const m of [...left]) if (covers(best, m)) left.delete(m)
  }
  // Textbook order: terms with earlier variables first, plain before complemented.
  const key = (p: Implicant) => Array.from({ length: n }, (_, i) => { const bit = 1 << (n - 1 - i); return p.mask & bit ? 2 : p.value & bit ? 0 : 1 })
  const compare = (a: Implicant, b: Implicant) => { const ka = key(a), kb = key(b); for (let i = 0; i < n; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]; return 0 }
  return [...chosen].sort(compare)
}

/** A group as a product term, e.g. A·C'. */
export function termOf(vars: string[], p: Implicant) {
  const n = vars.length
  return vars.map((v, i) => {
    const bit = 1 << (n - 1 - i)
    return p.mask & bit ? '' : p.value & bit ? v : `${v}'`
  }).filter(Boolean).join('·') || '1'
}

/** The smallest sum of products for the rows where an output is 1 (`dontCares` may be either). */
export function minimize(vars: string[], minterms: number[], dontCares: number[] = []): string {
  const groups = implicants(vars.length, minterms, dontCares)
  return groups.length ? groups.map(p => termOf(vars, p)).join(' + ') : '0'
}

const bitCount = (x: number) => { let c = 0; while (x) { x &= x - 1; c++ } return c }

/** The simplified expression for each output of a truth table (unknown outputs count as either). */
export function expressions(table: TruthTable): Record<string, string> {
  const out: Record<string, string> = {}
  table.outputs.forEach((name, o) => {
    const ones: number[] = [], either: number[] = []
    table.rows.forEach((row, i) => { if (row.out[o] === 1) ones.push(i); else if (row.out[o] === null) either.push(i) })
    out[name] = minimize(table.inputs, ones, either)
  })
  return out
}

// ---- Expressions ----

export type Expr =
  | { op: 'var'; name: string }
  | { op: 'const'; value: 0 | 1 }
  | { op: 'not'; arg: Expr }
  | { op: 'and' | 'or' | 'xor'; args: Expr[] }

type Token = { t: 'var' | 'const' | 'op' | '(' | ')'; v: string }

function tokenize(text: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) { i++; continue }
    const word = /^[A-Za-z]+/.exec(text.slice(i))?.[0]
    if (word && /^(AND|OR|NOT|XOR|NAND|NOR|XNOR)$/i.test(word) && !/[A-Za-z0-9_]/.test(text[i + word.length] ?? '')) {
      out.push({ t: 'op', v: word.toUpperCase() }); i += word.length; continue
    }
    if (/[A-Za-z]/.test(c)) {
      // A letter and any digits after it: "AB" is A·B, "A1" one name.
      const m = /^[A-Za-z][0-9_]*/.exec(text.slice(i))![0]
      out.push({ t: 'var', v: m }); i += m.length; continue
    }
    if (c === '0' || c === '1') { out.push({ t: 'const', v: c }); i++; continue }
    if (c === '(' || c === ')') { out.push({ t: c, v: c }); i++; continue }
    const ops: Record<string, string> = { '+': 'OR', '|': 'OR', '∨': 'OR', '·': 'AND', '*': 'AND', '&': 'AND', '∧': 'AND', '.': 'AND', '^': 'XOR', '⊕': 'XOR', '!': 'NOT', '~': 'NOT', '¬': 'NOT', "'": "'", '’': "'" }
    if (ops[c]) { out.push({ t: 'op', v: ops[c] }); i++; continue }
    throw new Error(`I don't understand "${c}"`)
  }
  return out
}

/** Reads an expression: + | OR for or, · * & AND (or just AB) for and, ^ ⊕ XOR, ' ! ~ ¬ NOT for not. */
export function parse(text: string): Expr {
  const tokens = tokenize(text)
  let at = 0
  const peek = () => tokens[at]
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v
  const flat = (op: 'and' | 'or' | 'xor', args: Expr[]): Expr => args.length === 1 ? args[0] : { op, args: args.flatMap(a => (a.op === op ? (a as { args: Expr[] }).args : [a])) }
  function primary(): Expr {
    const tok = peek()
    if (!tok) throw new Error('The expression ends too soon')
    let e: Expr
    if (tok.t === 'op' && tok.v === 'NOT') { at++; return { op: 'not', arg: primary() } }
    if (tok.t === 'var') { at++; e = { op: 'var', name: tok.v.toUpperCase() } }
    else if (tok.t === 'const') { at++; e = { op: 'const', value: tok.v === '1' ? 1 : 0 } }
    else if (tok.t === '(') {
      at++
      e = orExpr()
      if (peek()?.t !== ')') throw new Error('A ")" is missing')
      at++
    } else throw new Error(`Unexpected "${tok.v}"`)
    while (isOp("'")) { at++; e = { op: 'not', arg: e } }
    return e
  }
  function andExpr(): Expr {
    const args = [primary()]
    for (;;) {
      if (isOp('AND')) { at++; args.push(primary()); continue }
      const t = peek()
      // Side by side means "and": AB, A(B+C), A'B.
      if (t && (t.t === 'var' || t.t === 'const' || t.t === '(' || (t.t === 'op' && t.v === 'NOT'))) { args.push(primary()); continue }
      break
    }
    return flat('and', args)
  }
  function xorExpr(): Expr {
    const args = [andExpr()]
    while (isOp('XOR')) { at++; args.push(andExpr()) }
    return flat('xor', args)
  }
  function orExpr(): Expr {
    const args = [xorExpr()]
    while (isOp('OR')) { at++; args.push(xorExpr()) }
    return flat('or', args)
  }
  const e = orExpr()
  if (at < tokens.length) throw new Error(`Unexpected "${tokens[at].v}"`)
  return e
}

export function variables(e: Expr, into = new Set<string>()): string[] {
  if (e.op === 'var') into.add(e.name)
  else if (e.op === 'not') variables(e.arg, into)
  else if (e.op !== 'const') e.args.forEach(a => variables(a, into))
  return [...into].sort()
}

export function evaluate(e: Expr, env: Record<string, 0 | 1>): 0 | 1 {
  switch (e.op) {
    case 'var': return env[e.name] ?? 0
    case 'const': return e.value
    case 'not': return evaluate(e.arg, env) ? 0 : 1
    case 'and': return e.args.every(a => evaluate(a, env)) ? 1 : 0
    case 'or': return e.args.some(a => evaluate(a, env)) ? 1 : 0
    case 'xor': return (e.args.filter(a => evaluate(a, env)).length % 2) as 0 | 1
  }
}

/** "Y = A·B + C; Z = A ^ B" (or one expression, named Y): each output's expression. */
export function parseOutputs(text: string): Array<{ name: string; expr: Expr }> {
  const parts = text.split(/[;\n]/).map(s => s.trim()).filter(Boolean)
  const used = new Set<string>()
  return parts.map((part, i) => {
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(part)
    const name = m ? m[1].toUpperCase() : ['Y', 'Z', 'W', 'V'].find(n => !used.has(n)) ?? `F${i + 1}`
    used.add(name)
    return { name, expr: parse(m ? m[2] : part) }
  })
}

/** The truth table of expressions (inputs in alphabetical order). */
export function tableOf(outputs: Array<{ name: string; expr: Expr }>): TruthTable {
  const inputs = [...new Set(outputs.flatMap(o => variables(o.expr)))].sort()
  const n = inputs.length
  const table: TruthTable = { inputs, outputs: outputs.map(o => o.name), rows: [], sequential: false }
  if (n > MAX_TABLE_INPUTS) return { ...table, error: `More than ${MAX_TABLE_INPUTS} inputs` }
  for (let row = 0; row < 2 ** n; row++) {
    const bits = inputs.map((_, i) => ((row >> (n - 1 - i)) & 1) as 0 | 1)
    const env = Object.fromEntries(inputs.map((v, i) => [v, bits[i]]))
    table.rows.push({ in: bits, out: outputs.map(o => evaluate(o.expr, env)) })
  }
  return table
}

/** Writes an expression back out (for showing what was understood). */
export function show(e: Expr, parent = 0): string {
  const rank = { or: 1, xor: 2, and: 3 } as const
  switch (e.op) {
    case 'var': return e.name
    case 'const': return String(e.value)
    case 'not': return e.arg.op === 'var' || e.arg.op === 'const' ? `${show(e.arg)}'` : `(${show(e.arg)})'`
    default: {
      const sep = e.op === 'or' ? ' + ' : e.op === 'xor' ? ' ⊕ ' : '·'
      const text = e.args.map(a => show(a, rank[e.op])).join(sep)
      return rank[e.op] < parent ? `(${text})` : text
    }
  }
}

// ---- Building a circuit from expressions ----

let counter = 0
export const newId = (prefix = 'p') => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

/** A circuit for the expressions: switches on the left, gates by depth, LEDs on the right. */
export function buildCircuit(outputs: Array<{ name: string; expr: Expr }>): Circuit {
  const parts: Part[] = []
  const wires: Wire[] = []
  const inputs = [...new Set(outputs.flatMap(o => variables(o.expr)))].sort()
  const source = new Map<string, string>()
  inputs.forEach((name, i) => {
    const p: Part = { id: newId('s'), kind: 'switch', x: 40, y: 40 + i * 70, label: name, on: false }
    parts.push(p)
    source.set(name, pinRef(p, 'out'))
  })
  const notOf = new Map<string, string>()
  const columns: number[] = []
  const place = (depth: number) => { columns[depth] = (columns[depth] ?? 0) + 1; return { x: 160 + depth * 120, y: 30 + (columns[depth] - 1) * 90 } }
  const wire = (a: string, b: string) => wires.push({ id: newId('w'), a, b })
  let constants: Record<0 | 1, string> | null = null
  const constant = (v: 0 | 1) => {
    if (!constants) {
      const hi: Part = { id: newId('v'), kind: 'vcc', x: 40, y: 40 + inputs.length * 70 }
      const lo: Part = { id: newId('g'), kind: 'gnd', x: 40, y: 110 + inputs.length * 70 }
      parts.push(hi, lo)
      constants = { 1: pinRef(hi, 'out'), 0: pinRef(lo, 'out') }
    }
    return constants[v]
  }
  // Returns the pin carrying the value of `e`, and how deep its gates go.
  const build = (e: Expr): { pin: string; depth: number } => {
    if (e.op === 'var') return { pin: source.get(e.name)!, depth: 0 }
    if (e.op === 'const') return { pin: constant(e.value), depth: 0 }
    if (e.op === 'not' && e.arg.op === 'var' && notOf.has(e.arg.name)) return { pin: notOf.get(e.arg.name)!, depth: 1 }
    const args = e.op === 'not' ? [e.arg] : e.args
    // Four inputs at most per gate: more are split into a tree.
    if (args.length > 4 && e.op !== 'not') {
      const half = Math.ceil(args.length / 2)
      return build({ op: e.op, args: [{ op: e.op, args: args.slice(0, half) }, { op: e.op, args: args.slice(half) }] } as Expr)
    }
    const children = args.map(build)
    const depth = Math.max(...children.map(c => c.depth)) + 1
    const gate: GateType = e.op === 'not' ? 'NOT' : e.op === 'and' ? 'AND' : e.op === 'or' ? 'OR' : 'XOR'
    const g: Part = { id: newId('g'), kind: 'gate', gate, inputs: children.length, ...place(depth) }
    parts.push(g)
    children.forEach((c, i) => wire(c.pin, pinRef(g, `in${i}`)))
    const out = pinRef(g, 'out')
    if (e.op === 'not' && e.arg.op === 'var') notOf.set(e.arg.name, out)
    return { pin: out, depth }
  }
  const results = outputs.map(o => ({ o, r: build(o.expr) }))
  const right = 160 + (Math.max(0, ...results.map(x => x.r.depth)) + 1) * 120
  results.forEach(({ o, r }, i) => {
    const led: Part = { id: newId('l'), kind: 'led', x: right, y: 40 + i * 70, label: o.name }
    parts.push(led)
    wire(r.pin, pinRef(led, 'in'))
  })
  return { version: 1, parts, wires }
}

// ---- Putting gates on chips ----

export type ChipUse = { ref: string; part: string; name: string; slots: Array<{ gate: string; pins: number[]; out: number } | null> }
export type ChipPlan = { chips: ChipUse[]; connections: Array<{ net: string; pins: string[] }>; notes: string[] }

/** Which chips the circuit's gates need, which gate goes where, and what to wire to which pin. */
export function chipPlan(c: Circuit): ChipPlan {
  const netOf = nets(c)
  const names = partNames(c)
  const notes: string[] = []
  // Net names: a switch's label, an LED's label, else n1, n2…
  const netName = new Map<string, string>()
  for (const p of c.parts) {
    if ((p.kind === 'switch' || p.kind === 'clock') && p.label) netName.set(netOf.get(pinRef(p, 'out'))!, p.label)
    if (p.kind === 'vcc') netName.set(netOf.get(pinRef(p, 'out'))!, '+5V')
    if (p.kind === 'gnd') netName.set(netOf.get(pinRef(p, 'out'))!, 'GND')
  }
  for (const p of c.parts) if (p.kind === 'led' && p.label && !netName.has(netOf.get(pinRef(p, 'in'))!)) netName.set(netOf.get(pinRef(p, 'in'))!, p.label)
  let n = 0
  const nameOf = (net: string) => { if (!netName.has(net)) netName.set(net, `n${++n}`); return netName.get(net)! }
  // Each gate as primitive gates the chips have (wide gates split into trees).
  type Prim = { type: GateType; ins: string[]; out: string; from: string }
  const prims: Prim[] = []
  const limits: Partial<Record<GateType, number>> = { AND: 4, NAND: 4, OR: 2, NOR: 3, XOR: 2, XNOR: 2, NOT: 1 }
  const base: Partial<Record<GateType, GateType>> = { NAND: 'AND', NOR: 'OR', XNOR: 'XOR' }
  let temp = 0
  const emit = (type: GateType, ins: string[], out: string, from: string): void => {
    const limit = limits[type] ?? 0
    if (type === 'BUF') { notes.push(`${from} is a buffer: no chip needed, wire straight through.`); return }
    if (ins.length <= limit) { prims.push({ type, ins, out, from }); return }
    const plain = base[type] ?? type
    const half = Math.ceil(ins.length / 2)
    // Each half through its own gate (a single input needs none), then the two together.
    const part = (list: string[]) => { if (list.length === 1) return list[0]; const t = `t${++temp}`; emit(plain, list, t, from); return t }
    emit(type, [part(ins.slice(0, half)), part(ins.slice(half))], out, from)
  }
  for (const p of c.parts.filter(p => p.kind === 'gate')) {
    const count = p.gate === 'NOT' || p.gate === 'BUF' ? 1 : p.inputs ?? 2
    const ins = Array.from({ length: count }, (_, i) => nameOf(netOf.get(pinRef(p, `in${i}`))!))
    emit(p.gate ?? 'AND', ins, nameOf(netOf.get(pinRef(p, 'out'))!), names[p.id])
  }
  // Chips: the first with room for each gate (by type and input count).
  const chips: ChipUse[] = []
  const pinsOn: Array<[string, string]> = []
  let u = c.parts.filter(p => p.kind === 'chip').length
  for (const prim of prims) {
    const def = CHIPS.find(d => d.gates.length && d.gates[0].type === prim.type && d.gates[0].ins.length === prim.ins.length)
      ?? CHIPS.find(d => d.gates.length && d.gates[0].type === prim.type && d.gates[0].ins.length > prim.ins.length)
    if (!def) { notes.push(`No chip for a ${prim.ins.length}-input ${prim.type} (${prim.from}).`); continue }
    let use = chips.find(ch => ch.part === def.part && ch.slots.some(s => s === null))
    if (!use) {
      use = { ref: `U${++u}`, part: def.part, name: def.name, slots: def.gates.map(() => null) }
      chips.push(use)
    }
    const slot = use.slots.indexOf(null)
    const g = def.gates[slot]
    // A wider gate than needed: spare inputs tied so they don't change the result.
    const spare = prim.type === 'AND' || prim.type === 'NAND' ? '+5V' : 'GND'
    const ins = g.ins.map((_, i) => prim.ins[i] ?? spare)
    use.slots[slot] = { gate: prim.from, pins: g.ins, out: g.out }
    g.ins.forEach((pin, i) => pinsOn.push([ins[i], `${use!.ref} pin ${pin}`]))
    pinsOn.push([prim.out, `${use.ref} pin ${g.out}`])
  }
  for (const ch of chips) {
    const def = chipDef(ch.part)!
    pinsOn.push(['+5V', `${ch.ref} pin ${def.vcc}`], ['GND', `${ch.ref} pin ${def.gnd}`])
    // Unused gates' inputs to ground (floating TTL inputs pick up noise).
    def.gates.forEach((g, i) => { if (!ch.slots[i]) g.ins.forEach(pin => pinsOn.push(['GND', `${ch.ref} pin ${pin} (unused)`])) })
  }
  for (const p of c.parts) {
    if (p.kind === 'switch' && p.label) pinsOn.push([p.label, `switch ${p.label}`])
    if (p.kind === 'led' && p.label) pinsOn.push([nameOf(netOf.get(pinRef(p, 'in'))!), `LED ${p.label} (through a 330 Ω resistor to GND)`])
  }
  const byNet = new Map<string, string[]>()
  for (const [net, pin] of pinsOn) {
    if (net.startsWith('t')) continue
    byNet.set(net, [...(byNet.get(net) ?? []), pin])
  }
  // The joints inside split gates are nets too.
  for (const [net, pin] of pinsOn) if (net.startsWith('t')) byNet.set(net, [...(byNet.get(net) ?? []), pin])
  const order = (s: string) => (s === '+5V' ? 0 : s === 'GND' ? 1 : 2)
  const connections = [...byNet].map(([net, pins]) => ({ net, pins })).sort((a, b) => order(a.net) - order(b.net) || a.net.localeCompare(b.net, undefined, { numeric: true }))
  return { chips, connections, notes }
}

export const emptyCircuit = (): Circuit => ({ version: 1, parts: [], wires: [] })

/** A saved circuit, checked (anything odd is dropped rather than trusted). */
export function readCircuit(text: string): Circuit {
  const raw = JSON.parse(text)
  const parts: Part[] = Array.isArray(raw?.parts) ? raw.parts.filter((p: Part) => typeof p?.id === 'string' && typeof p.x === 'number' && typeof p.y === 'number' && ['switch', 'clock', 'led', 'vcc', 'gnd', 'gate', 'chip', 'seg7'].includes(p.kind)) : []
  const ids = new Set(parts.map(p => p.id))
  const wires: Wire[] = Array.isArray(raw?.wires) ? raw.wires.filter((w: Wire) => typeof w?.a === 'string' && typeof w.b === 'string' && ids.has(w.a.split(':')[0]) && ids.has(w.b.split(':')[0])) : []
  return { version: 1, parts, wires }
}

/** A truth table as Markdown (for a note). */
export function tableMarkdown(table: TruthTable, exprs: Record<string, string> = {}): string {
  const head = [...table.inputs, ...table.outputs]
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
  for (const row of table.rows) lines.push(`| ${[...row.in, ...row.out.map(v => (v === null ? '?' : v))].join(' | ')} |`)
  const ex = Object.entries(exprs).map(([k, v]) => `- ${k} = ${v}`)
  return [lines.join('\n'), ex.length ? `\n${ex.join('\n')}` : ''].join('\n')
}

// ---- Karnaugh maps ----

/** Gray-code order: neighbours differ in one bit. */
const gray = (bits: number) => Array.from({ length: 2 ** bits }, (_, i) => i ^ (i >> 1))

export type KMap = { rowVars: string[]; colVars: string[]; rows: number[]; cols: number[]; cell: (row: number, col: number) => number }

/** The layout of a Karnaugh map for 2 to 4 variables (rows: the first half, columns: the rest),
 *  null for other sizes. `cell` gives the truth table row (minterm) at a place. */
export function kmapLayout(vars: string[]): KMap | null {
  const n = vars.length
  if (n < 2 || n > 4) return null
  const rowBits = Math.floor(n / 2), colBits = n - rowBits
  return { rowVars: vars.slice(0, rowBits), colVars: vars.slice(rowBits), rows: gray(rowBits), cols: gray(colBits), cell: (r, c) => (r << colBits) | c }
}

/** Which groups (by index in `groups`) cover a minterm. */
export const groupsCovering = (groups: Implicant[], m: number) => groups.flatMap((g, i) => ((m & ~g.mask) === g.value ? [i] : []))

/** An output's 1s, don't-cares and the groups of its smallest sum of products. */
export function kmapGroups(table: TruthTable, out: number) {
  const ones: number[] = [], either: number[] = []
  table.rows.forEach((row, i) => { if (row.out[out] === 1) ones.push(i); else if (row.out[out] === null) either.push(i) })
  return { ones, either, groups: implicants(table.inputs.length, ones, either) }
}

// ---- Timing diagrams ----

export type Timing = { steps: number; signals: Array<{ name: string; kind: 'in' | 'clock' | 'out'; values: Level[] }> }

/** Every clock, switch and LED over `cycles` clock cycles from power-up (two steps a cycle: clock
 *  low, then high — the rising edge). Switches stay where they are. */
export function timing(c: Circuit, cycles: number): Timing {
  const clocks = c.parts.filter(p => p.kind === 'clock')
  const switches = c.parts.filter(p => p.kind === 'switch').sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
  const leds = c.parts.filter(p => p.kind === 'led').sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
  const signals: Timing['signals'] = [
    ...clocks.map(p => ({ name: p.label ?? 'CLK', kind: 'clock' as const, values: [] as Level[] })),
    ...switches.map(p => ({ name: p.label ?? '?', kind: 'in' as const, values: [] as Level[] })),
    ...leds.map(p => ({ name: p.label ?? '?', kind: 'out' as const, values: [] as Level[] })),
  ]
  let state: FlopState = {}
  const steps = cycles * 2
  for (let step = 0; step < steps; step++) {
    const sim = simulate(c, { clock: step % 2 === 1, state })
    state = sim.state
    let i = 0
    for (const p of clocks) signals[i++].values.push(sim.pins[pinRef(p, 'out')] ?? null)
    for (const p of switches) signals[i++].values.push(p.on ? 1 : 0)
    for (const p of leds) signals[i++].values.push(sim.pins[pinRef(p, 'in')] ?? null)
  }
  return { steps, signals }
}
