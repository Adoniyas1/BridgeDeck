import { describe, expect, it } from 'vitest'
import { bendIndex, pinFacing, rotateBy90, wirePath, pinPoint, buildCircuit, buildWithRules, chipPlan, designSummary, minimizePOS, posExpressions, groupsCovering, kmapGroups, kmapLayout, termOf, timing, expressions, minimize, parse, parseOutputs, pinRef, pinsOf, readCircuit, show, simulate, tableMarkdown, tableOf, truthTable, type Circuit, type Part } from './model'

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

describe('16-pin chips, displays, maps and timing', () => {
  const power = (id = 'u'): Part[] => [{ id: `${id}v`, kind: 'vcc', x: 0, y: 0 }, { id: `${id}g`, kind: 'gnd', x: 0, y: 0 }]
  const powered = (id = 'u') => [w(`${id}v:out`, `${id}:16`), w(`${id}g:out`, `${id}:8`)]

  it('decodes BCD to segments on a 7447 driving a common-anode display', () => {
    const c: Circuit = {
      version: 1,
      parts: [sw('a', 'A'), sw('b', 'B'), sw('c', 'C'), sw('d', 'D'), { id: 'u', kind: 'chip', x: 0, y: 0, chip: '7447' }, { id: 's', kind: 'seg7', x: 0, y: 0, on: true }, ...power()],
      wires: [w('a:out', 'u:7'), w('b:out', 'u:1'), w('c:out', 'u:2'), w('d:out', 'u:6'), ...powered(),
        ...Object.entries({ a: 13, b: 12, c: 11, d: 10, e: 9, f: 15, g: 14 }).map(([seg, pin]) => w(`u:${pin}`, `s:${seg}`))],
    }
    const lit = (n: number) => {
      const set = { ...c, parts: c.parts.map(p => (p.kind === 'switch' ? { ...p, on: !!(n & (1 << 'ABCD'.indexOf(p.label!))) } : p)) }
      const sim = simulate(set)
      return 'abcdefg'.split('').filter(seg => sim.pins[`s:${seg}`] === 0).join('')
    }
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(lit)).toEqual(['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'cdefg', 'abc', 'abcdefg', 'abcfg'])
    expect(simulate(c).warnings).toEqual([])
  })

  it('selects one output of a 74138 and one input of a 74151', () => {
    const decoder: Circuit = {
      version: 1,
      parts: [sw('a', 'A'), sw('b', 'B'), { id: 'u', kind: 'chip', x: 0, y: 0, chip: '74138' }, led('y', 'Y'), ...power(), { id: 'e', kind: 'vcc', x: 0, y: 0 }],
      // A and B select; C, G2A and G2B low; G1 high. The LED watches Y2 (active low).
      wires: [w('a:out', 'u:1'), w('b:out', 'u:2'), w('ug:out', 'u:3'), w('ug:out', 'u:4'), w('ug:out', 'u:5'), w('e:out', 'u:6'), w('u:13', 'y:in'), ...powered()],
    }
    expect(column(decoder)).toEqual([1, 0, 1, 1])
    const mux: Circuit = {
      version: 1,
      parts: [sw('a', 'A'), sw('b', 'B'), { id: 'u', kind: 'chip', x: 0, y: 0, chip: '74151' }, led('y', 'Y'), ...power()],
      // D1 and D2 high, the rest low; C low, strobe low.
      wires: [w('b:out', 'u:11'), w('a:out', 'u:10'), w('ug:out', 'u:9'), w('ug:out', 'u:7'), w('uv:out', 'u:3'), w('uv:out', 'u:2'),
        ...[4, 1, 15, 14, 13, 12].map(p => w('ug:out', `u:${p}`)), w('u:5', 'y:in'), ...powered()],
    }
    // Rows are A (select B) then B (select A): selected inputs 0, 1, 2, 3.
    expect(column(mux)).toEqual([0, 1, 1, 0])
  })

  it('counts on a 74161, clears at once, and shows it on a timing diagram', () => {
    const c: Circuit = {
      version: 1,
      parts: [{ id: 'k', kind: 'clock', x: 0, y: 0, label: 'CLK' }, sw('r', 'R', true), { id: 'u', kind: 'chip', x: 0, y: 0, chip: '74161' }, led('qa', 'QA'), led('qb', 'QB'), ...power()],
      wires: [w('k:out', 'u:2'), w('r:out', 'u:1'), w('u:15', 'qa:in'), w('u:14', 'qb:in'), ...powered()],
    }
    const t = timing(c, 4)
    expect(t.signals.map(s => s.name)).toEqual(['CLK', 'R', 'QA', 'QB'])
    expect(t.signals[0].values).toEqual([0, 1, 0, 1, 0, 1, 0, 1])
    expect(t.signals[2].values).toEqual([0, 1, 1, 0, 0, 1, 1, 0])
    expect(t.signals[3].values).toEqual([0, 0, 0, 1, 1, 1, 1, 0])
    const cleared = { ...c, parts: c.parts.map(p => (p.id === 'r' ? { ...p, on: false } : p)) }
    let sim = simulate(c, { clock: false })
    sim = simulate(c, { clock: true, state: sim.state })
    expect(sim.pins['qa:in']).toBe(1)
    sim = simulate(cleared, { clock: true, state: sim.state })
    expect(sim.pins['qa:in']).toBe(0)
    expect(truthTable(c).sequential).toBe(true)
  })

  it('lays out Karnaugh maps in Gray code with the simplest groups', () => {
    const map = kmapLayout(['A', 'B', 'C', 'D'])!
    expect(map.rows).toEqual([0, 1, 3, 2])
    expect(map.cell(3, 2)).toBe(0b1110)
    expect(kmapLayout(['A'])).toBeNull()
    const table = tableOf(parseOutputs("Y = B·D' + A'·C"))
    const { groups } = kmapGroups(table, 0)
    expect(groups.map(g => termOf(table.inputs, g))).toEqual(["A'·C", "B·D'"])
    expect(groupsCovering(groups, 0b0110)).toEqual([0, 1])
  })
})

describe('designing with rules (EE 201 voting box)', () => {
  const majority = tableOf(parseOutputs('Y = AB + AC + BC'))
  const five = tableOf(parseOutputs('Y = ABC + ABD + ABE + ACD + ACE + ADE + BCD + BCE + BDE + CDE'))
  const outputs = (c: Circuit) => truthTable(c).rows.map(r => r.out[0])
  const gatesOf = (c: Circuit) => c.parts.filter(p => p.kind === 'gate')

  it('gives both the sum of products and the product of sums', () => {
    expect(expressions(majority).Y).toBe('A·B + A·C + B·C')
    expect(posExpressions(majority).Y).toBe('(A + B)·(A + C)·(B + C)')
    expect(minimizePOS(['A', 'B'], [0, 1, 2, 3])).toBe('1')
    expect(minimizePOS(['A', 'B'], [])).toBe('0')
  })

  it('builds the majority vote from 2-input NAND gates only, and it works for every input', () => {
    const c = buildWithRules(majority, { gates: 'nand', maxInputs: 2 })
    expect(outputs(c)).toEqual(majority.rows.map(r => r.out[0]))
    expect(gatesOf(c).every(g => g.gate === 'NAND' && (g.inputs ?? 2) <= 2)).toBe(true)
    const s = designSummary(c)
    // Three 2-input NANDs for AB, AC, BC; the 3-input NAND of those as a tree: NAND, inverter, NAND.
    expect(s.gates).toBe(6)
    expect(s.inverters).toBe(1)
    expect(s.chips).toEqual({ '7400': 2 })
  })

  it('uses a 3-input NAND (7410) when allowed: the textbook two-level circuit', () => {
    const c = buildWithRules(majority, { gates: 'nand', maxInputs: 3 })
    expect(outputs(c)).toEqual(majority.rows.map(r => r.out[0]))
    expect(designSummary(c)).toMatchObject({ gates: 4, inverters: 0, chips: { '7400': 1, '7410': 1 } })
  })

  it('builds it from NOR gates only, from the product of sums', () => {
    const c = buildWithRules(majority, { gates: 'nor', maxInputs: 2 })
    expect(outputs(c)).toEqual(majority.rows.map(r => r.out[0]))
    expect(gatesOf(c).every(g => g.gate === 'NOR' && (g.inputs ?? 2) <= 2)).toBe(true)
  })

  it('handles complemented inputs with NAND inverters, and the 5-voter extension', () => {
    const t = tableOf(parseOutputs("Y = A'B + C"))
    const c = buildWithRules(t, { gates: 'nand', maxInputs: 2 })
    expect(outputs(c)).toEqual(t.rows.map(r => r.out[0]))
    expect(gatesOf(c).every(g => g.gate === 'NAND')).toBe(true)
    for (const maxInputs of [2, 3, 4] as const) {
      const big = buildWithRules(five, { gates: 'nand', maxInputs })
      expect(outputs(big)).toEqual(five.rows.map(r => r.out[0]))
      expect(gatesOf(big).every(g => g.gate === 'NAND' && (g.inputs ?? 2) <= maxInputs)).toBe(true)
    }
  })

  it('wires constant outputs to +5 V or ground', () => {
    const always = tableOf(parseOutputs("Y = A + A'"))
    expect(outputs(buildWithRules(always, { gates: 'nand', maxInputs: 2 }))).toEqual([1, 1])
    expect(outputs(buildWithRules(always, { gates: 'nor', maxInputs: 2 }))).toEqual([1, 1])
  })
})

describe('rotating parts and shaping wires', () => {
  const g = (rot?: Part['rot']): Part => ({ id: 'g', kind: 'gate', x: 100, y: 100, gate: 'AND', inputs: 2, rot })

  it('turns pins with the part, about its middle', () => {
    // A 2-input AND is 60×40: its output at (70, 20); turned 90° it points down from the middle.
    expect(pinPoint(g(), 'out')).toEqual({ x: 170, y: 120 })
    expect(pinPoint(g(90), 'out')).toEqual({ x: 130, y: 160 })
    expect(pinPoint(g(180), 'out')).toEqual({ x: 90, y: 120 })
    expect(pinFacing(g(), 'out')).toEqual({ x: 1, y: 0 })
    expect(pinFacing(g(90), 'out')).toEqual({ x: 0, y: 1 })
    expect(pinFacing(g(180), 'in0')).toEqual({ x: 1, y: 0 })
    expect(rotateBy90(270)).toBe(0)
  })

  it('rotating a gate changes the drawing, not the logic', () => {
    const turnedAdder: Circuit = { ...halfAdder, parts: halfAdder.parts.map(p => (p.kind === 'gate' ? { ...p, rot: 90 } : p)) }
    expect(truthTable(turnedAdder).rows).toEqual(truthTable(halfAdder).rows)
  })

  it('draws wires straight, curved, at right angles, and through bend points', () => {
    const from = { x: 0, y: 0, fx: 1, fy: 0 }, to = { x: 100, y: 50, fx: -1, fy: 0 }
    const w = { id: 'w', a: 'x:out', b: 'y:in0' }
    expect(wirePath({ ...w, shape: 'straight' }, from, to)).toBe('M0,0 L100,50')
    expect(wirePath({ ...w, shape: 'curved' }, from, to)).toMatch(/^M0,0 C/)
    expect(wirePath(w, from, to)).toMatch(/^M0,0 H\d+ V50 H100$/)
    expect(wirePath({ ...w, via: [{ x: 50, y: 80 }] }, from, to)).toBe('M0,0 H50 V80 H100 V50')
    expect(wirePath({ ...w, shape: 'straight', via: [{ x: 50, y: 80 }] }, from, to)).toBe('M0,0 L50,80 L100,50')
    // A new bend goes into the stretch it's nearest to.
    expect(bendIndex({ ...w, via: [{ x: 50, y: 0 }] }, from, to, { x: 90, y: 30 })).toBe(1)
  })

  it('keeps rotation, wire shapes and bends when saved, and drops nonsense', () => {
    const saved = JSON.stringify({ parts: [{ ...sw('a', 'A'), rot: 90 }, { ...led('l', 'Y'), rot: 45 }], wires: [{ id: 'w', a: 'a:out', b: 'l:in', shape: 'curved', via: [{ x: 1, y: 2 }, { x: 'bad' }] }, { id: 'v', a: 'a:out', b: 'l:in', shape: 'zigzag' }] })
    const c = readCircuit(saved)
    expect(c.parts.map(p => p.rot)).toEqual([90, undefined])
    expect(c.wires[0]).toMatchObject({ shape: 'curved', via: [{ x: 1, y: 2 }] })
    expect(c.wires[1].shape).toBeUndefined()
  })
})
