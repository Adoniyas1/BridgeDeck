/** State machines: a state diagram (Moore or Mealy) turned into a state table, flip-flop equations
 *  (D flip-flops, simplified like the K-map does) and a circuit built from 7474s and gates. */
import { CHIPS, minimize, newId, parse, pinRef, readCircuit, synthesize, type Circuit, type Part, type Wire } from './model'

export type Bit = 0 | 1
export type FsmState = { id: string; name: string; x: number; y: number; /** Moore: the outputs in this state. */ out: Record<string, Bit> }
/** `when`: one character per input, 0, 1 or - (either); empty matches anything. */
export type FsmTransition = { id: string; from: string; to: string; when: string; /** Mealy: the outputs on this transition. */ out: Record<string, Bit> }
export type Fsm = { kind: 'moore' | 'mealy'; inputs: string[]; outputs: string[]; states: FsmState[]; transitions: FsmTransition[]; start: string }

const state = (id: string, name: string, x: number, y: number, out: Record<string, Bit> = {}): FsmState => ({ id, name, x, y, out })
const go = (from: string, to: string, when: string, out: Record<string, Bit> = {}): FsmTransition => ({ id: newId('t'), from, to, when, out })

/** A first example: Z = 1 after two 1s in a row on X (Moore). */
export function exampleFsm(): Fsm {
  return {
    kind: 'moore',
    inputs: ['X'],
    outputs: ['Z'],
    states: [state('s0', 'S0', 140, 160, { Z: 0 }), state('s1', 'S1', 340, 160, { Z: 0 }), state('s2', 'S2', 540, 160, { Z: 1 })],
    transitions: [go('s0', 's0', '0'), go('s0', 's1', '1'), go('s1', 's0', '0'), go('s1', 's2', '1'), go('s2', 's0', '0'), go('s2', 's2', '1')],
    start: 's0',
  }
}

/** A name a variable can have here: a letter, then digits (X, X1, Z2). */
export const validName = (name: string) => /^[A-Z][0-9]*$/.test(name)

/** Does a `when` pattern match these input bits? */
export function matches(when: string, bits: Bit[]): boolean {
  return [...when].every((c, i) => c === '-' || c === undefined || i >= bits.length || Number(c) === bits[i])
}

/** Reads a typed condition: "1", "0", "10", "1-", "X=1", "X'", "X Y'" (inputs in order) → pattern. */
export function readWhen(text: string, inputs: string[]): string | null {
  const t = text.trim().toUpperCase()
  if (!t || t === '-' || t === 'ANY' || t === 'ELSE') return '-'.repeat(inputs.length)
  if (/^[01-]+$/.test(t) && t.length === inputs.length) return t
  const pattern = inputs.map(() => '-')
  // X=1, X=0, X, X'
  const terms = t.split(/[\s,·*&]+/).filter(Boolean)
  for (const term of terms) {
    const m = /^([A-Z][0-9]*)\s*(=\s*([01])|'|)$/.exec(term)
    if (!m) return null
    const i = inputs.indexOf(m[1])
    if (i < 0) return null
    pattern[i] = m[2] === "'" ? '0' : m[3] ?? '1'
  }
  return pattern.join('')
}

/** How a pattern reads: "X=1", "X=1, Y=0", "always". */
export function showWhen(when: string, inputs: string[]): string {
  const parts = [...when].map((c, i) => (c === '-' || !inputs[i] ? '' : `${inputs[i]}=${c}`)).filter(Boolean)
  return parts.length ? parts.join(', ') : 'always'
}

export const stateBits = (n: number) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))))

export type FsmRow = { state: string; code: number; input: Bit[]; next: string; nextCode: number; out: Record<string, Bit> }
export type FsmAnalysis = {
  /** State variables, most significant first (Q1, Q0). */
  bits: string[]
  codes: Record<string, number>
  rows: FsmRow[]
  /** D1 = …, D0 = …, then each output. */
  equations: Array<{ name: string; expr: string }>
  warnings: string[]
  flipFlops: number
}

const bitsOf = (n: number, width: number): Bit[] => Array.from({ length: width }, (_, i) => ((n >> (width - 1 - i)) & 1) as Bit)

/** The state table and the simplified equations: each D input and each output as a sum of products
 *  of the state bits (and, for next states and Mealy outputs, the inputs). Codes go in order with
 *  the start state 00…0 (so a reset to all zeros starts there); unused codes are don't-cares. */
export function analyze(fsm: Fsm): FsmAnalysis {
  const warnings: string[] = []
  const order = [fsm.states.find(s => s.id === fsm.start), ...fsm.states.filter(s => s.id !== fsm.start)].filter((s): s is FsmState => !!s)
  const k = stateBits(order.length)
  const bits = Array.from({ length: k }, (_, i) => `Q${k - 1 - i}`)
  const codes = Object.fromEntries(order.map((s, i) => [s.id, i]))
  const nIn = fsm.inputs.length
  const vars = [...bits, ...fsm.inputs]
  const rows: FsmRow[] = []
  const ones: Record<string, number[]> = {}
  const dc: number[] = []
  const name = (id: string) => fsm.states.find(s => s.id === id)?.name ?? '?'
  for (let code = 0; code < 2 ** k; code++) {
    for (let inp = 0; inp < 2 ** nIn; inp++) {
      const minterm = (code << nIn) | inp
      const s = order[code]
      if (!s) { dc.push(minterm); continue }
      const input = bitsOf(inp, nIn)
      const hits = fsm.transitions.filter(t => t.from === s.id && matches(t.when, input))
      if (new Set(hits.map(t => t.to)).size > 1) warnings.push(`${s.name}: more than one arrow for ${showWhen(input.join(''), fsm.inputs) || 'the same inputs'} (${hits.map(t => name(t.to)).join(', ')}); the first is used.`)
      const t = hits[0]
      if (!t && !warnings.some(w => w.startsWith(`${s.name} has no`))) warnings.push(`${s.name} has no arrow for ${showWhen(input.join(''), fsm.inputs)}: it stays in ${s.name} then.`)
      const next = t ? t.to : s.id
      const nextCode = codes[next] ?? code
      const out: Record<string, Bit> = Object.fromEntries(fsm.outputs.map(o => [o, (fsm.kind === 'moore' ? s.out[o] : t?.out[o]) ?? 0]))
      rows.push({ state: s.name, code, input, next: name(next), nextCode, out })
      bitsOf(nextCode, k).forEach((b, i) => { if (b) (ones[`D${k - 1 - i}`] ??= []).push(minterm) })
      fsm.outputs.forEach(o => { if (out[o]) (ones[o] ??= []).push(minterm) })
    }
  }
  if (!order.length) warnings.push('Add a state to start.')
  const equations = [...bits.map(b => `D${b.slice(1)}`), ...fsm.outputs].map(n => ({ name: n, expr: order.length ? minimize(vars, ones[n] ?? [], dc) : '0' }))
  return { bits, codes, rows, equations, warnings, flipFlops: k }
}

/** The machine as a circuit: a 7474 flip-flop per state bit (clocked by CLK, cleared by RST: turn
 *  RST off for a moment to go back to the start state), gates for each D input and output, an LED
 *  per output and per state bit, and the chips' power. */
export function buildFsmCircuit(fsm: Fsm): Circuit {
  const a = analyze(fsm)
  const parts: Part[] = []
  const wires: Wire[] = []
  const wire = (x: string, y: string) => wires.push({ id: newId('w'), a: x, b: y })
  const source = new Map<string, string>()
  const notSource = new Map<string, string>()
  fsm.inputs.forEach((name, i) => {
    const p: Part = { id: newId('s'), kind: 'switch', x: 40, y: 40 + i * 70, label: name, on: false }
    parts.push(p)
    source.set(name, pinRef(p, 'out'))
  })
  const below = 40 + fsm.inputs.length * 70
  const clk: Part = { id: newId('c'), kind: 'clock', x: 40, y: below, label: 'CLK' }
  const rst: Part = { id: newId('s'), kind: 'switch', x: 40, y: below + 80, label: 'RST', on: true }
  const vcc: Part = { id: newId('v'), kind: 'vcc', x: 40, y: below + 160 }
  const gnd: Part = { id: newId('g'), kind: 'gnd', x: 40, y: below + 230 }
  parts.push(clk, rst, vcc, gnd)
  // The flip-flops, two to a 7474, to the right of the logic (placed once its width is known).
  const def = CHIPS.find(c => c.part === '7474')!
  const chips: Part[] = Array.from({ length: Math.ceil(a.flipFlops / 2) }, () => ({ id: newId('u'), kind: 'chip', chip: '7474', x: 0, y: 0 }))
  const flop = (i: number) => ({ chip: chips[Math.floor(i / 2)], pins: def.flops![i % 2] })
  a.bits.forEach((b, i) => {
    const { chip, pins } = flop(i)
    source.set(b, pinRef(chip, String(pins.q)))
    notSource.set(b, pinRef(chip, String(pins.nq)))
  })
  const exprs = a.equations.map(e => parse(e.expr))
  const { pins, right } = synthesize(parts, wires, exprs, source, notSource, 200, { x: 40, y: below + 300 })
  chips.forEach((chip, i) => {
    chip.x = right + 40
    chip.y = 60 + i * 170
    parts.push(chip)
    wire(pinRef(vcc, 'out'), pinRef(chip, String(def.vcc)))
    wire(pinRef(gnd, 'out'), pinRef(chip, String(def.gnd)))
  })
  a.bits.forEach((_, i) => {
    const { chip, pins: f } = flop(i)
    wire(pinRef(clk, 'out'), pinRef(chip, String(f.clk)))
    wire(pinRef(vcc, 'out'), pinRef(chip, String(f.pre)))
    wire(pinRef(rst, 'out'), pinRef(chip, String(f.clr)))
    wire(pins[i], pinRef(chip, String(f.d)))
  })
  // LEDs: each output, then the state bits (to watch the state change).
  const ledX = right + 280
  const leds = [...fsm.outputs.map((o, i) => ({ label: o, pin: pins[a.bits.length + i] })), ...a.bits.map(b => ({ label: b, pin: source.get(b)! }))]
  leds.forEach((l, i) => {
    const led: Part = { id: newId('l'), kind: 'led', x: ledX, y: 40 + i * 70, label: l.label }
    parts.push(led)
    wire(l.pin, pinRef(led, 'in'))
  })
  return { version: 1, parts, wires, fsm: structuredClone(fsm) }
}

/** A saved machine, checked (anything odd is dropped rather than trusted). */
export function readFsm(raw: unknown): Fsm | undefined {
  const f = raw as Partial<Fsm> | undefined
  if (!f || typeof f !== 'object' || !Array.isArray(f.states) || !Array.isArray(f.transitions)) return undefined
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && validName(n)).slice(0, 6) : [])
  const bitsRec = (v: unknown, keys: string[]) => Object.fromEntries(keys.map(k => [k, ((v as Record<string, unknown> | undefined)?.[k] === 1 ? 1 : 0) as Bit]))
  const inputs = names(f.inputs), outputs = names(f.outputs)
  const states = f.states.filter(s => typeof s?.id === 'string' && typeof s.x === 'number' && typeof s.y === 'number').slice(0, 64).map(s => ({ id: s.id, name: String(s.name ?? s.id).slice(0, 12), x: s.x, y: s.y, out: bitsRec(s.out, outputs) }))
  const ids = new Set(states.map(s => s.id))
  const transitions = f.transitions.filter(t => ids.has(t?.from) && ids.has(t?.to) && typeof t.when === 'string' && /^[01-]*$/.test(t.when)).map(t => ({ id: typeof t.id === 'string' ? t.id : newId('t'), from: t.from, to: t.to, when: t.when.slice(0, inputs.length), out: bitsRec(t.out, outputs) }))
  return { kind: f.kind === 'mealy' ? 'mealy' : 'moore', inputs, outputs, states, transitions, start: ids.has(f.start as string) ? (f.start as string) : states[0]?.id ?? '' }
}

/** A saved circuit with its state machine, if it has one. */
export function loadCircuit(text: string): Circuit {
  const c = readCircuit(text)
  let fsm: Fsm | undefined
  try { fsm = readFsm(JSON.parse(text)?.fsm) } catch { fsm = undefined }
  return fsm ? { ...c, fsm } : c
}
