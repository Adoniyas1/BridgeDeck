import { describe, expect, it } from 'vitest'
import { buildCircuit, chipPlan, expressions, minimize, parse, parseOutputs, pinRef, pinsOf, readCircuit, show, simulate, tableMarkdown, tableOf, truthTable, type Circuit, type Part } from './model'

const sw = (id: string, label: string, on = false): Part => ({ id, kind: 'switch', x: 0, y: 0, label, on })
const led = (id: string, label: string): Part => ({ id, kind: 'led', x: 0, y: 0, label })
const gate = (id: string, type: Part['gate'], inputs = 2): Part => ({ id, kind: 'gate', x: 0, y: 0, gate: type, inputs })
const w = (a: string, b: string) => ({ id: `${a}-${b}`, a, b })

/** A half adder from gates: S = A ⊕ B, C = A·B. */
const halfAdder: Circuit = {
  version: 1,
  parts: [sw('a', 'A'), sw('b', 'B'), gate('x', 'XOR'), gate('n', 'AND'), led('s', 'S'), led('c', 'C')],
  wires: [w('a:out', 'x:in0'), w('b:out', 'x:in1'), w('a:out', 'n:in0'), w('b:out', 'n:in1'), w('x:out', 's:in'), w('n:out', 'c:in')],
}

/** One chip with its power, A and B on two inputs and an LED on the output. */
function onChip(part: string, ins: number[], out: number, powered = true): Circuit {
  const parts: Part[] = [sw('a', 'A'), sw('b', 'B'), { id: 'u', kind: 'chip', x: 0, y: 0, chip: part }, led('y', 'Y'), { id: 'v', kind: 'vcc', x: 0, y: 0 }, { id: 'g', kind: 'gnd', x: 0, y: 0 }]
  const wires = [w('a:out', `u:${ins[0]}`), w('b:out', `u:${ins[1]}`), w(`u:${out}`, 'y:in')]
  if (powered) wires.push(w('v:out', 'u:14'), w('g:out', 'u:7'))
  return { version: 1, parts, wires }
}
const column = (c: Circuit) => truthTable(c).rows.map(r => r.out[0])

describe('logic simulation', () => {
  it('fills in the truth table and expressions of a half adder', () => {
    const table = truthTable(halfAdder)
    expect(table.inputs).toEqual(['A', 'B'])
    expect(table.outputs).toEqual(['C', 'S'])
    expect(table.rows.map(r => [...r.in, ...r.out])).toEqual([[0, 0, 0, 0], [0, 1, 0, 1], [1, 0, 0, 1], [1, 1, 1, 0]])
    expect(expressions(table)).toEqual({ C: 'A·B', S: "A·B' + A'·B" })
    expect(simulate(halfAdder).warnings).toEqual([])
    expect(tableMarkdown(table, expressions(table))).toContain('| A | B | C | S |\n| --- | --- | --- | --- |\n| 0 | 0 | 0 | 0 |')
  })

  it('uses the datasheet pinouts of the chips, which only work powered', () => {
    expect(column(onChip('7400', [1, 2], 3))).toEqual([1, 1, 1, 0])
    expect(column(onChip('7408', [12, 13], 11))).toEqual([0, 0, 0, 1])
    expect(column(onChip('7402', [2, 3], 1))).toEqual([1, 0, 0, 0])
    expect(column(onChip('7432', [9, 10], 8))).toEqual([0, 1, 1, 1])
    expect(column(onChip('7486', [4, 5], 6))).toEqual([0, 1, 1, 0])
    expect(column(onChip('74266', [12, 13], 11))).toEqual([1, 0, 0, 1])
    const off = onChip('7408', [1, 2], 3, false)
    expect(column(off)).toEqual([null, null, null, null])
    expect(simulate(off).warnings[0]).toContain('U1 (7408) has no power')
    const dip = pinsOf({ id: 'u', kind: 'chip', x: 0, y: 0, chip: '7408' })
    expect(dip.find(p => p.name === '1')!.y).toBeGreaterThan(dip.find(p => p.name === '14')!.y)
    expect(dip.find(p => p.name === '14')!.dir).toBe('power')
  })

  it('knows a 0 decides an AND even with another input unconnected, and reports the loose wire', () => {
    const c: Circuit = { version: 1, parts: [sw('a', 'A', false), gate('n', 'AND'), led('y', 'Y')], wires: [w('a:out', 'n:in0'), w('n:out', 'y:in')] }
    const sim = simulate(c)
    expect(sim.pins['y:in']).toBe(0)
    expect(sim.warnings.join(' ')).toContain("input that isn't connected")
    const on = simulate({ ...c, parts: c.parts.map(p => (p.id === 'a' ? { ...p, on: true } : p)) })
    expect(on.pins['y:in']).toBe(null)
  })

  it('spots two outputs fighting on one wire', () => {
    const c: Circuit = { version: 1, parts: [sw('a', 'A', true), sw('b', 'B', false), led('y', 'Y')], wires: [w('a:out', 'y:in'), w('b:out', 'y:in')] }
    const sim = simulate(c)
    expect(sim.shorts.length).toBe(2)
    expect(sim.pins['y:in']).toBe(null)
  })

  it('clocks a 7474 flip-flop on the rising edge', () => {
    const c: Circuit = {
      version: 1,
      parts: [sw('d', 'D', true), { id: 'k', kind: 'clock', x: 0, y: 0, label: 'CLK' }, { id: 'u', kind: 'chip', x: 0, y: 0, chip: '7474' }, led('q', 'Q'), { id: 'v', kind: 'vcc', x: 0, y: 0 }, { id: 'g', kind: 'gnd', x: 0, y: 0 }],
      wires: [w('d:out', 'u:2'), w('k:out', 'u:3'), w('u:5', 'q:in'), w('v:out', 'u:14'), w('g:out', 'u:7')],
    }
    let sim = simulate(c, { clock: false })
    expect(sim.pins['q:in']).toBe(0)
    sim = simulate(c, { clock: true, state: sim.state })
    expect(sim.pins['q:in']).toBe(1)
    const low = { ...c, parts: c.parts.map(p => (p.id === 'd' ? { ...p, on: false } : p)) }
    sim = simulate(low, { clock: true, state: sim.state })
    expect(sim.pins['q:in']).toBe(1)
    sim = simulate(low, { clock: false, state: sim.state })
    sim = simulate(low, { clock: true, state: sim.state })
    expect(sim.pins['q:in']).toBe(0)
    expect(truthTable(c).sequential).toBe(true)
  })
})

describe('expressions', () => {
  it('reads the usual ways of writing them', () => {
    expect(show(parse("AB + C'"))).toBe("A·B + C'")
    expect(show(parse('A AND (B OR NOT C)'))).toBe("A·(B + C')")
    expect(show(parse('!(A+B)'))).toBe("(A + B)'")
    expect(show(parse('A ^ B ⊕ C'))).toBe('A ⊕ B ⊕ C')
    expect(show(parse('a*b|c'))).toBe('A·B + C')
    expect(() => parse('A + (B')).toThrow(')')
    expect(() => parse('A $ B')).toThrow('$')
    expect(parseOutputs('S = A ^ B; C = AB').map(o => o.name)).toEqual(['S', 'C'])
  })

  it('makes truth tables and simplifies them', () => {
    const table = tableOf(parseOutputs('Y = A·B + A·C + B·C'))
    expect(table.rows.map(r => r.out[0])).toEqual([0, 0, 0, 1, 0, 1, 1, 1])
    expect(expressions(table).Y).toBe('A·B + A·C + B·C')
    expect(minimize(['A', 'B', 'C'], [0, 1, 2, 5, 6, 7]).split(' + ').length).toBe(3)
    expect(minimize(['A', 'B'], [])).toBe('0')
    expect(minimize(['A', 'B'], [0, 1, 2, 3])).toBe('1')
    expect(minimize(['A', 'B', 'C', 'D'], [1, 3, 5, 7, 9, 11, 13, 15])).toBe('D')
    expect(minimize(['A', 'B', 'C'], [1, 3], [5, 7])).toBe('C')
  })

  it('builds a circuit that does what the expression says', () => {
    const outputs = parseOutputs("Y = A'B + AB'; Z = (A + B + C + D + E)")
    const circuit = buildCircuit(outputs)
    const built = truthTable(circuit)
    const wanted = tableOf(outputs)
    expect(built.inputs).toEqual(wanted.inputs)
    expect(built.rows.map(r => r.out)).toEqual(wanted.rows.map(r => r.out))
    expect(circuit.parts.filter(p => p.gate === 'NOT').length).toBe(2)
    expect(Math.max(...circuit.parts.filter(p => p.kind === 'gate').map(p => p.inputs ?? 1))).toBeLessThanOrEqual(4)
    expect(readCircuit(JSON.stringify(circuit)).parts.length).toBe(circuit.parts.length)
    expect(readCircuit('{"parts":[{"id":"x","kind":"virus","x":0,"y":0}],"wires":[{"a":"x:1","b":"y:2"}]}')).toEqual({ version: 1, parts: [], wires: [] })
  })
})

describe('chip plans', () => {
  it('puts gates on chips with pin-by-pin wiring', () => {
    const plan = chipPlan(halfAdder)
    expect(plan.chips.map(c => c.part)).toEqual(['7486', '7408'])
    const net = (name: string) => plan.connections.find(c => c.net === name)!.pins
    expect(net('A')).toEqual(expect.arrayContaining(['U1 pin 1', 'U2 pin 1', 'switch A']))
    expect(net('+5V')).toEqual(expect.arrayContaining(['U1 pin 14', 'U2 pin 14']))
    expect(net('GND')).toEqual(expect.arrayContaining(['U1 pin 7', 'U1 pin 4 (unused)']))
    expect(net('S')).toEqual(expect.arrayContaining(['U1 pin 3', 'LED S (through a 330 Ω resistor to GND)']))
  })

  it('splits gates no chip has into ones that exist', () => {
    const c: Circuit = { version: 1, parts: [sw('a', 'A'), sw('b', 'B'), sw('c', 'C'), gate('o', 'OR', 3), gate('m', 'NOR', 4), led('y', 'Y'), led('z', 'Z')], wires: [w('a:out', 'o:in0'), w('b:out', 'o:in1'), w('c:out', 'o:in2'), w('o:out', 'y:in'), w('a:out', 'm:in0'), w('b:out', 'm:in1'), w('c:out', 'm:in2'), w('c:out', 'm:in3'), w('m:out', 'z:in')] }
    const plan = chipPlan(c)
    // 3-input OR: two 2-input ORs. 4-input NOR: two ORs and a 2-input NOR.
    expect(plan.chips.map(ch => `${ch.part}:${ch.slots.filter(Boolean).length}`)).toEqual(['7432:4', '7402:1'])
    expect(plan.notes).toEqual([])
    expect(pinRef({ id: 'u', kind: 'chip', x: 0, y: 0 }, '3')).toBe('u:3')
  })
})
