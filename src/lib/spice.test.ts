import { describe, expect, it } from 'vitest'
import { Simulation } from 'eecircuit-engine'
import { cutoff, needsNgspice, problems, readResult, shownTraces, toNgspice } from './spice'

describe('circuits for ngspice', () => {
  it('sends only what the homework solver can’t do', () => {
    expect(needsNgspice('V1 in 0 12V\nR1 in out 4.7k\nR2 out 0 10k\n? V(out)')).toBe(false)
    expect(needsNgspice('V1 in 0 5∠30°\nC1 in 0 1u\n.ac 1kHz')).toBe(false)
    expect(needsNgspice('V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 10 10 100k')).toBe(true)
    expect(needsNgspice('V1 in 0 PULSE(0 5 0 1n 1n 1m 2m)\nR1 in out 1k')).toBe(true)
    expect(needsNgspice('V1 a 0 5\nD1 a 0 D1N4148')).toBe(true)
    expect(needsNgspice('R1 a 0 1k\n.tran 1u 1m')).toBe(true)
  })

  it('cleans a netlist for ngspice', () => {
    expect(toNgspice('R1 in out 4.7kΩ\nC1 out 0 10µF\n? V(out)\n.end')).toBe('* BridgeDeck circuit\nR1 in out 4.7k\nC1 out 0 10uF\n.end')
  })

  it('keeps warnings and errors, not chatter', () => {
    expect(problems(['', "Warning: 'r1 in' is not a valid resistor instance line, ignored!", 'Note: v1: has no value, DC 0 assumed', 'Circuit: x'])).toEqual(["Warning: 'r1 in' is not a valid resistor instance line, ignored!"])
  })

  it('finds a filter’s cutoff', () => {
    const f = Array.from({ length: 31 }, (_, i) => 10 ** (1 + i / 10))
    const g = f.map(x => -10 * Math.log10(1 + (x / 159.15) ** 2))
    expect(cutoff(f, g)).toBeGreaterThan(150)
    expect(cutoff(f, g)).toBeLessThan(168)
    expect(cutoff([1, 2], [0, -1])).toBeNull()
  })

  it('runs real circuits in ngspice: a step into an RC, a low-pass sweep and a diode', async () => {
    const sim = new Simulation()
    await sim.start()
    const run = async (text: string) => { sim.setNetList(toNgspice(text)); return readResult(await sim.runSim()) }

    const step = await run('V1 in 0 PULSE(0 5 0 1n 1n 10m 20m)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 5m')
    if (step.kind !== 'time') throw new Error(step.kind)
    const out = step.traces.find(t => t.name === 'V(out)')!
    const atTau = out.values[step.x.values.findIndex(t => t >= 1e-3)]
    expect(atTau).toBeCloseTo(5 * (1 - Math.exp(-1)), 1)
    expect(shownTraces(step.traces).map(t => t.name)).toEqual(['V(in)', 'V(out)', 'I(V1)'])

    const sweep = await run('V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 50 10 100k')
    if (sweep.kind !== 'freq') throw new Error(sweep.kind)
    const gain = sweep.traces.find(t => t.name === 'V(out)')!
    const fc = cutoff(sweep.x.values, gain.values)!
    expect(fc).toBeGreaterThan(150)
    expect(fc).toBeLessThan(168)
    const phase = sweep.phases.find(t => t.name === 'V(out)')!
    expect(phase.values[phase.values.length - 1]).toBeLessThan(-80)

    const diode = await run('V1 in 0 DC 5\nR1 in a 1k\nD1 a 0 DMOD\n.model DMOD D(Is=1e-14)\n.op')
    if (diode.kind !== 'point') throw new Error(diode.kind)
    const va = diode.values.find(v => v.name === 'V(a)')!.value
    expect(va).toBeGreaterThan(0.6)
    expect(va).toBeLessThan(0.8)
  }, 60_000)
})
