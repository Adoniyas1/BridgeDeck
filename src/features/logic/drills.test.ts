import { describe, expect, it } from 'vitest'
import { checkDrill, makeDrill, rng, type Drill } from './drills'

describe('logic drills', () => {
  it('makes each kind and marks answers', () => {
    const rand = rng(7)
    for (const kind of ['base', 'twos', 'kmap'] as const) {
      const d = makeDrill(kind, rand)
      expect(checkDrill(d, d.answer).right).toBe(true)
    }
  })
  it('accepts other correct forms and explains wrong ones', () => {
    expect(checkDrill({ kind: 'base', question: '', answer: 'FF' }, '0xff').right).toBe(true)
    expect(checkDrill({ kind: 'twos', question: '', answer: '11111011', bits: 8 }, '1111 1011').right).toBe(true)
    expect(checkDrill({ kind: 'twos', question: '', answer: '-5', bits: 8 }, '-5').right).toBe(true)
    const kmap: Drill = { kind: 'kmap', question: '', vars: ['A', 'B', 'C'], minterms: [0, 1, 2, 3, 7], answer: "A' + BC" }
    expect(checkDrill(kmap, "BC + A'").right).toBe(true)
    expect(checkDrill(kmap, "A'B' + A'B + BC")).toMatchObject({ right: false, message: expect.stringMatching(/not minimal/) })
    expect(checkDrill(kmap, 'A + B').message).toMatch(/Not the same function/)
    expect(checkDrill(kmap, 'A + Z').message).toMatch(/Only A, B, C/)
  })
})

describe('predict, then simulate', () => {
  it('marks guesses against the table, skipping don’t-cares', async () => {
    const { markPrediction } = await import('./drills')
    const rows: Array<{ out: Array<0 | 1 | null> }> = [{ out: [0, null] }, { out: [1, 1] }]
    expect(markPrediction(rows, { '0:0': 0, '1:0': 0 })).toEqual({ right: 1, total: 3, wrong: [{ row: 1, out: 0 }, { row: 1, out: 1 }] })
  })
})
