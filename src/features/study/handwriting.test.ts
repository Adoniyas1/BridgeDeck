import { describe, expect, it } from 'vitest'
import katex from 'katex'
import { badMathLines, doubtfulLines } from './handwriting'

const check = (tex: string, display: boolean) => { try { katex.renderToString(tex, { throwOnError: true, displayMode: display }); return true } catch { return false } }

describe('checking read handwriting', () => {
  it('flags math that does not typeset and garbled lines', () => {
    expect(badMathLines('Ohm: $V = IR$\nBad: $\\frac{1}{$\n$$\\int_0^1 x\\,dx$$', check)).toEqual([1])
    expect(doubtfulLines('Kirchhoff current law\nI1 + I2 = I3\n~|| ¬ ¶ x7q\n')).toEqual([2])
  })
})

describe('corrections kept for next time', () => {
  it('finds words swapped one for one, not edits', async () => {
    const { corrections, mergeFixes } = await import('./handwriting')
    expect(corrections('the Vovt across R1 is', 'the Vout across R1 is about')).toEqual([['Vovt', 'Vout']])
    expect(corrections('Kirchoff law: sum of currents', 'Kirchhoff law: sum of all currents')).toEqual([['Kirchoff', 'Kirchhoff']])
    expect(corrections('x = $a+b$', 'x = $a+c$')).toEqual([])
    expect(mergeFixes(['Vovt=>Vovt2', 'junk'], [['Vovt', 'Vout'], ['lnput', 'input']])).toEqual(['Vovt=>Vout', 'lnput=>input'])
  })
})
