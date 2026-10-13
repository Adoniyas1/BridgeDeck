import { describe, expect, it } from 'vitest'
import { breadboard, checkWiring, parseSpot, ROWS_TOP, spotKey, spotName, type Board, type Spot } from './boardLayout'
import { buildWithRules, chipPlan, readCircuit, tableOf, parseOutputs, type Circuit } from './model'

const majority = () => buildWithRules(tableOf(parseOutputs('Y = AB + AC + BC')), { gates: 'nand', maxInputs: 2 })

describe('breadboard layout', () => {
  it('puts each chip across the channel, pin 1 in row f, with room between', () => {
    const b = breadboard(majority())
    expect(b.chips.map(ch => [ch.ref, ch.part, ch.col])).toEqual([['U1', '7400', 3], ['U2', '7400', 13]])
    expect(b.inputs).toEqual(['A', 'B', 'C'])
    expect(b.outputs).toEqual(['Y'])
    expect(b.steps[0].text).toContain('pin 1 in f3')
    expect(b.steps.filter(st => st.jumper !== undefined)).toHaveLength(b.jumpers.length)
    expect(b.cols).toBeLessThan(63)
  })

  it('wires power to the rail on the same side, same column', () => {
    const b = breadboard(majority())
    const vcc = b.jumpers.find(j => j.net === '+5V' && j.a.kind === 'hole' && j.a.col === 3)!
    // U1 pin 14 sits in e3 (top half): its jumper starts in d3 and goes to the top + rail.
    expect(vcc.a).toEqual({ kind: 'hole', col: 3, row: 'd' })
    expect(vcc.b).toEqual({ kind: 'rail', col: 3, rail: 'top+' })
    const gnd = b.jumpers.find(j => j.net === 'GND' && j.a.kind === 'hole' && j.a.col === 9)!
    // U1 pin 7 in f9 (bottom half): to the bottom ground rail.
    expect(gnd.a).toEqual({ kind: 'hole', col: 9, row: 'g' })
    expect(gnd.b).toEqual({ kind: 'rail', col: 9, rail: 'bottom-' })
    expect(vcc.color).toBe('#e0383e')
  })

  it('chains each signal from the switch rightwards, in free holes of the strip', () => {
    const b = breadboard(majority())
    const a = b.jumpers.filter(j => j.net === 'A')
    expect(a[0].a).toEqual({ kind: 'switch', label: 'A' })
    const holes = b.jumpers.flatMap(j => [j.a, j.b]).filter((s): s is Extract<Spot, { kind: 'hole' }> => s.kind === 'hole')
    // Never a chip leg's own hole (row e or f), and never the same hole twice.
    expect(holes.every(h => h.row !== 'e' && h.row !== 'f')).toBe(true)
    expect(new Set(holes.map(h => `${h.row}${h.col}`)).size).toBe(holes.length)
    expect(b.jumpers.some(j => j.b.kind === 'led' && j.b.label === 'Y')).toBe(true)
  })

  it('follows a chip moved by hand, and keeps chips apart', () => {
    expect(breadboard(majority(), { U2: 30 }).chips.find(ch => ch.ref === 'U2')!.col).toBe(30)
    // Onto U1: moved along until it fits.
    const clash = breadboard(majority(), { U2: 5 }).chips
    expect(clash[1].col).toBeGreaterThanOrEqual(clash[0].col + 8)
    // Off the edge: kept on the board.
    expect(breadboard(majority(), { U2: 99 }).chips[1].col).toBe(63 - 7 + 1)
    expect(breadboard(majority(), { U2: 99 }).cols).toBe(63)
  })

  it('names spots the way a lab sheet does', () => {
    expect(spotName({ kind: 'hole', col: 12, row: 'c' })).toBe('c12')
    expect(spotName({ kind: 'rail', col: 4, rail: 'bottom-' })).toBe('bottom ground rail (column 4)')
    expect(spotName({ kind: 'switch', label: 'A' })).toBe('switch A')
  })
})

describe('chips placed by hand', () => {
  it('are wired as drawn and numbered before the gates’ chips', () => {
    const c: Circuit = {
      version: 1,
      parts: [
        { id: 's', kind: 'switch', x: 0, y: 0, label: 'A' },
        { id: 'k', kind: 'chip', chip: '7404', x: 100, y: 0 },
        { id: 'l', kind: 'led', x: 300, y: 0, label: 'Y' },
        { id: 'g', kind: 'gate', gate: 'NOT', x: 200, y: 100 },
      ],
      wires: [{ id: 'w1', a: 's:out', b: 'k:1' }, { id: 'w2', a: 'k:2', b: 'l:in' }, { id: 'w3', a: 's:out', b: 'g:in0' }],
    }
    const plan = chipPlan(c)
    expect(plan.chips.map(ch => [ch.ref, ch.part, !!ch.placed])).toEqual([['U1', '7404', true], ['U2', '7404', false]])
    const a = plan.connections.find(x => x.net === 'A')!
    expect(a.pins).toEqual(expect.arrayContaining(['U1 pin 1', 'switch A']))
    // Only the pins with wires: nothing made up for U1's other gates.
    expect(plan.connections.flatMap(x => x.pins).filter(p => p.startsWith('U1 ')).sort()).toEqual(['U1 pin 1', 'U1 pin 2'])
    expect(breadboard(c).chips.map(ch => ch.ref)).toEqual(['U1', 'U2'])
  })

  it('keeps where chips sit on the board when saved', () => {
    const c = readCircuit(JSON.stringify({ version: 1, parts: [], wires: [], board: { U1: 12, x: 3, U2: 1.5 } }))
    expect(c.board).toEqual({ U1: 12 })
  })
})

describe('wiring it yourself', () => {
  const board = () => breadboard(majority())
  const guide = (b: Board) => b.jumpers.map((j, i) => ({ id: `j${i}`, a: spotKey(j.a), b: spotKey(j.b), color: j.color }))

  it('reads and writes spots', () => {
    for (const s of [{ kind: 'hole', row: 'c', col: 12 }, { kind: 'rail', rail: 'bottom-', col: 4 }, { kind: 'switch', label: 'A' }, { kind: 'led', label: 'Y' }] as Spot[]) expect(parseSpot(spotKey(s))).toEqual(s)
    expect(parseSpot('z9')).toBeNull()
  })

  it('finds nothing to fix in the guide’s own wiring', () => {
    const b = board()
    const check = checkWiring(b, guide(b))
    expect(check.problems).toEqual([])
    expect(check.right).toBe(check.total)
  })

  it('says what is missing, and finds shorts', () => {
    const b = board()
    expect(checkWiring(b, []).right).toBe(0)
    const wires = guide(b)
    const missing = checkWiring(b, wires.filter(w => !w.a.startsWith('sw:A')))
    expect(missing.problems.some(p => p.startsWith('A: ') && p.includes('switch A'))).toBe(true)
    // A wire from switch A's strip to switch B's terminal joins the two signals.
    const short = checkWiring(b, [...wires, { id: 'x', a: 'sw:A', b: 'sw:B', color: '#000' }])
    expect(short.problems.some(p => /^Short: A and B/.test(p))).toBe(true)
    // Power and ground rails joined: a short too.
    expect(checkWiring(b, [...wires, { id: 'y', a: 'top+@1', b: 'top-@1', color: '#000' }]).problems.some(p => p.includes('+5V and GND'))).toBe(true)
  })

  it('any hole in the strip will do, and both rails carry power', () => {
    const b = board()
    const moved = guide(b).map(w => {
      const a = parseSpot(w.a)!
      return a.kind === 'hole' ? { ...w, a: spotKey({ ...a, row: ROWS_TOP.includes(a.row as never) ? 'a' : 'j' }) } : w
    }).map(w => ({ ...w, b: w.b.replace(/^top\+/, 'bottom+') }))
    expect(checkWiring(b, moved).problems).toEqual([])
  })

  it('keeps your wires when saved', () => {
    const c = readCircuit(JSON.stringify({ ...majority(), jumpers: [{ id: 'a', a: 'c3', b: 'top+@3', color: '#e0383e' }, { id: 'b', a: 'c3', b: 'x', color: 'red' }] }))
    expect(c.jumpers).toEqual([{ id: 'a', a: 'c3', b: 'top+@3', color: '#e0383e' }])
  })
})
