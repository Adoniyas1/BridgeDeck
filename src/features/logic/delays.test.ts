import { describe, expect, it } from 'vitest'
import { delayRun, levelAt } from './delays'
import { buildCircuit, parseOutputs, type Circuit } from './model'

/** Sets switches by label. */
const set = (c: Circuit, on: Record<string, boolean>): Circuit => ({ ...c, parts: c.parts.map(p => (p.kind === 'switch' && p.label! in on ? { ...p, on: on[p.label!] } : p)) })

describe('gate delays', () => {
  it('shows the classic static-1 hazard in Y = AB + A\'C when A falls with B = C = 1', () => {
    const c = set(buildCircuit(parseOutputs("Y = AB + A'C")), { A: true, B: true, C: true })
    const run = delayRun(c, 'A')
    const y = run.waves.find(w => w.name === 'Y')!
    expect(levelAt(y, 5)).toBe(1)
    // AB falls after 15 ns; A' rises after 10 and A'C after 15 more: the OR sees 0 in between.
    expect(run.glitches).toEqual([{ name: 'Y', from: 40, to: 50, kind: 'static' }])
    expect(levelAt(y, 45)).toBe(0)
    expect(levelAt(y, run.end)).toBe(1)
  })

  it('has no glitch when the cover term is there (Y = AB + A\'C + BC)', () => {
    const c = set(buildCircuit(parseOutputs("Y = AB + A'C + BC")), { A: true, B: true, C: true })
    expect(delayRun(c, 'A').glitches).toEqual([])
  })

  it('reports how long the circuit takes to settle', () => {
    const run = delayRun(buildCircuit(parseOutputs('Y = A')), 'A')
    expect(run.waves.find(w => w.name === 'Y')!.changes.map(ch => ch.v)).toEqual([0, 1])
    expect(run.settled).toBe(10)
  })
})
