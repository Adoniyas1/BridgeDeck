import { describe, expect, it } from 'vitest'
import { analyze, buildFsmCircuit, exampleFsm, loadCircuit, matches, readWhen, showWhen, stateBits, type Fsm } from './fsm'
import { simulate, type Circuit, type FlopState } from './model'

/** Clocks the circuit once per input value (low, then high), reading the LEDs after each edge. */
function run(c: Circuit, inputs: Array<Record<string, 0 | 1>>, read: string[]) {
  let circuit = c
  let state: FlopState = {}
  const out: string[] = []
  const set = (vals: Record<string, 0 | 1>) => { circuit = { ...circuit, parts: circuit.parts.map(p => (p.kind === 'switch' && p.label && p.label in vals ? { ...p, on: vals[p.label] === 1 } : p)) } }
  // A reset first: RST low, then high again.
  set({ RST: 0 }); state = simulate(circuit, { clock: false, state }).state; set({ RST: 1 }); state = simulate(circuit, { clock: false, state }).state
  for (const vals of inputs) {
    set(vals)
    state = simulate(circuit, { clock: false, state }).state
    const sim = simulate(circuit, { clock: true, state })
    state = sim.state
    const led = (label: string) => sim.pins[`${circuit.parts.find(p => p.kind === 'led' && p.label === label)!.id}:in`]
    out.push(read.map(led).join(''))
  }
  return out
}

describe('state machines', () => {
  it('reads conditions written several ways', () => {
    expect(readWhen('1', ['X'])).toBe('1')
    expect(readWhen("X'", ['X'])).toBe('0')
    expect(readWhen('X=1, Y=0', ['X', 'Y'])).toBe('10')
    expect(readWhen('Y', ['X', 'Y'])).toBe('-1')
    expect(readWhen('', ['X', 'Y'])).toBe('--')
    expect(readWhen('Q=1', ['X'])).toBeNull()
    expect(showWhen('1-', ['X', 'Y'])).toBe('X=1')
    expect(matches('1-', [1, 0])).toBe(true)
    expect(matches('1-', [0, 0])).toBe(false)
    expect([stateBits(1), stateBits(2), stateBits(3), stateBits(5)]).toEqual([1, 1, 2, 3])
  })

  it('makes the state table and equations for the "11" detector', () => {
    const a = analyze(exampleFsm())
    expect(a.bits).toEqual(['Q1', 'Q0'])
    expect(a.rows).toHaveLength(6)
    expect(a.rows.find(r => r.state === 'S1' && r.input[0] === 1)!.next).toBe('S2')
    expect(Object.fromEntries(a.equations.map(e => [e.name, e.expr]))).toEqual({ D1: 'Q1·X + Q0·X', D0: "Q1'·Q0'·X", Z: 'Q1' })
    expect(a.warnings).toEqual([])
  })

  it('builds a circuit from 7474s that runs like the diagram', () => {
    const c = buildFsmCircuit(exampleFsm())
    expect(c.parts.filter(p => p.kind === 'chip').map(p => p.chip)).toEqual(['7474'])
    expect(simulate(c).warnings).toEqual([])
    // X: 1 1 1 0 1 1 → Z after each edge: 0 1 1 0 0 1
    expect(run(c, [1, 1, 1, 0, 1, 1].map(x => ({ X: x as 0 | 1 })), ['Z'])).toEqual(['0', '1', '1', '0', '0', '1'])
  })

  it('handles a Mealy machine and warns about missing arrows', () => {
    // Mealy: Z = 1 when X is 1 for the second time in a row.
    const fsm: Fsm = { kind: 'mealy', inputs: ['X'], outputs: ['Z'], start: 'a', states: [{ id: 'a', name: 'A', x: 0, y: 0, out: {} }, { id: 'b', name: 'B', x: 0, y: 0, out: {} }], transitions: [
      { id: '1', from: 'a', to: 'b', when: '1', out: { Z: 0 } }, { id: '2', from: 'b', to: 'b', when: '1', out: { Z: 1 } }, { id: '3', from: 'b', to: 'a', when: '0', out: { Z: 0 } },
    ] }
    const a = analyze(fsm)
    expect(a.warnings).toEqual(['A has no arrow for X=0: it stays in A then.'])
    expect(a.equations.find(e => e.name === 'Z')!.expr).toBe('Q0·X')
    const c = buildFsmCircuit(fsm)
    expect(c.fsm?.kind).toBe('mealy')
    expect(loadCircuit(JSON.stringify(c)).fsm?.transitions).toHaveLength(3)
  })
})
