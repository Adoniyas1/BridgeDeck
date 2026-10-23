import { describe, expect, it } from 'vitest'
import { parseNetlist, runChecks, solve, valueOf } from './mna'
import { formatQuantity } from './expr'

const show = (text: string, what: string) => { const net = parseNetlist(text); expect(net.errors).toEqual([]); return formatQuantity(valueOf(solve(net), what)!) }

describe('circuit solver', () => {
  it('solves DC circuits', () => {
    const divider = 'V1 in 0 12V\nR1 in out 4.7k\nR2 out 0 10k'
    expect(show(divider, 'V(out)')).toBe('8.163 V')
    expect(show(divider, 'I(R1)')).toBe('816.3 µA')
    expect(show(divider, 'I(V1)')).toBe('816.3 µA')
    expect(show('I1 0 a 2mA\nR1 a 0 1k\nR2 a 0 1k', 'V(a)')).toBe('1 V')
    // A capacitor is open and an inductor a short at DC.
    expect(show('V1 a 0 5\nR1 a b 1k\nC1 b 0 1u', 'V(b)')).toBe('5 V')
    expect(show('V1 a 0 5\nR1 a b 1k\nL1 b 0 1m', 'I(L1)')).toBe('5 mA')
  })
  it('solves at a frequency with phasors', () => {
    // An RC low-pass at its corner: 1/√2 of the input, 45° behind.
    const rc = 'V1 in 0 1V\nR1 in out 1k\nC1 out 0 159.155n\n.ac 1kHz'
    const v = valueOf(solve(parseNetlist(rc)), 'V(out)')!
    expect(Math.hypot(v.re, v.im)).toBeCloseTo(Math.SQRT1_2, 4)
    expect(Math.atan2(v.im, v.re) * 180 / Math.PI).toBeCloseTo(-45, 2)
  })
  it('checks answers, hiding values in check-only mode', () => {
    const net = parseNetlist('V1 in 0 12V\nR1 in out 4.7k\nR2 out 0 10k\n? V(out) = 8.2V\n? V(out) = 7V\n? I(R2)\n? V(nowhere)')
    const sol = solve(net)
    expect(runChecks(net, sol, false).map(r => r.message)).toEqual(['Right', 'Not right: it’s 8.163 V', '816.3 µA', 'There’s no V(nowhere) in this circuit'])
    const hidden = runChecks(net, sol, true)
    expect(hidden.map(r => r.shown)).toEqual([undefined, undefined, undefined, undefined])
    expect(hidden[1].message).toBe('Not right yet')
  })
  it('explains what it can’t read or solve', () => {
    expect(parseNetlist('X1 a b 1k').errors[0]).toMatch(/start with R, C, L, V or I/)
    expect(() => solve(parseNetlist('V1 a 0 5\nV2 a 0 3'))).toThrow(/no single answer/)
    expect(() => solve(parseNetlist('R1 a b 1k'))).toThrow(/ground/)
  })
})
