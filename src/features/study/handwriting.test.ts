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
