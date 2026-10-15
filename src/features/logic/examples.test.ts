import { describe, expect, it } from 'vitest'
import { EXAMPLES, sevenSegment } from './examples'
import { simulate, truthTable, type Circuit } from './model'

const led = (c: Circuit, pins: Record<string, unknown>, name: string) => {
  const p = c.parts.find(q => q.kind === 'led' && q.label === name)
  return p ? (pins as Record<string, number | null>)[`${p.id}:in`] : undefined
}

describe('examples', () => {
  it('all build into circuits with parts and wires', () => {
    for (const e of EXAMPLES) {
      const c = e.build()
      expect(c.parts.length, e.id).toBeGreaterThan(2)
      expect(c.wires.length, e.id).toBeGreaterThan(0)
    }
  })
  it('the full adder adds', () => {
    const t = truthTable(EXAMPLES.find(e => e.id === 'full-adder')!.build())
    for (const row of t.rows) {
      const sum = row.in.reduce((a: number, b) => a + Number(b), 0)
      expect(Number(row.out[t.outputs.indexOf('S')])).toBe(sum & 1)
      expect(Number(row.out[t.outputs.indexOf('CO')])).toBe(sum >> 1)
    }
  })
  it('the 7-segment decoder lights the right segments for each digit', () => {
    const text = sevenSegment()
    expect(text.split('\n')).toHaveLength(7)
    const t = truthTable(EXAMPLES.find(e => e.id === 'seven-seg')!.build())
    const digit = (n: number) => t.rows.find(r => t.inputs.every((name, i) => Number(r.in[i]) === ((n >> Number(name.slice(1))) & 1)))!
    const segs = (n: number) => t.outputs.filter((_, i) => digit(n).out[i] === 1).join('')
    expect(segs(8)).toBe('ABCDEFG')
    expect(segs(1)).toBe('BC')
    expect(segs(7)).toBe('ABC')
    const want = ['ABCDEF', 'BC', 'ABDEG', 'ABCDG', 'BCFG', 'ACDFG', 'ACDEFG', 'ABC', 'ABCDEFG', 'ABCDFG']
    want.forEach((w, n) => expect(segs(n), String(n)).toBe(w))
  })
  it('the counter counts on the clock', () => {
    const c = EXAMPLES.find(e => e.id === 'counter-4')!.build()
    let state = {}
    const seen: string[] = []
    let clock = false
    for (let i = 0; i < 9; i++) {
      clock = !clock
      const r = simulate(c, { clock, state })
      state = r.state
      if (clock) seen.push(`${led(c, r.pins, 'C1')}${led(c, r.pins, 'C0')}`)
    }
    expect(new Set(seen).size).toBe(4)
  })
})
