import { describe, expect, it } from 'vitest'
import { calculate, inDegrees, literal, readState, remember, show } from './calculator'

const run = (line: string, degrees = true, vars = {}) => show(calculate(line, vars, degrees).value)

describe('calculator', () => {
  it('works out plain arithmetic in full', () => {
    expect(run('2 + 3 * 4')).toBe('14')
    expect(run('(2 + 3) * 4 ^ 2')).toBe('80')
    expect(run('1/3')).toBe('0.333333333333')
    expect(run('12345678 * 1000')).toBe('12345678000')
    expect(run('2^50')).toBe('1.12589991e15')
    expect(run('sqrt(2)')).toBe('1.41421356237')
  })

  it('takes angles in degrees or radians', () => {
    expect(inDegrees('sin(30) + atan(1)')).toBe('sind(30) + atand(1)')
    expect(run('sin(30)')).toBe('0.5')
    expect(run('atan(1)')).toBe('45')
    expect(run('sin(pi/6)', false)).toBe('0.5')
  })

  it('keeps units, complex numbers and engineering prefixes', () => {
    expect(run('12V / 2.2kΩ')).toBe('5.45455 mA')
    expect(run('4.7k || 4.7k')).toBe('2350')
    expect(run('4.7kΩ || 4.7kΩ')).toBe('2.35 kΩ')
    expect(run('3 + 4j')).toBe('3 + j4 = 5 ∠ 53.13°')
  })

  it('remembers ans and names set with =', () => {
    let state = readState(null)
    const a = calculate('R = 4.7k', state.vars, true)
    state = remember(state, 'R = 4.7k', a.value, a.name)
    const b = calculate('R * 2', state.vars, true)
    state = remember(state, 'R * 2', b.value)
    expect(state.history.map(h => h.result)).toEqual(['4700', '9400'])
    expect(run('ans / 2', true, state.vars)).toBe('4700')
    expect(() => calculate('pi = 3', state.vars, true)).toThrow(/already means/)
    expect(() => calculate('2 +', state.vars, true)).toThrow()
    // Kept between runs, and a damaged copy starts afresh.
    expect(readState(JSON.stringify(state)).vars.R.re).toBe(4700)
    expect(readState('{"vars":{"x":{"re":"no"}},"history":[1]}')).toEqual({ history: [], vars: {}, degrees: true })
  })

  it('puts an answer back in the line as text it reads again', () => {
    for (const line of ['1/3', '12V / 2.2kΩ', '3 - 4j', '(3+4j) * 2V', '2^50']) {
      const v = calculate(line, {}, true).value
      const again = calculate(literal(v)!, {}, true).value
      expect(again.re).toBeCloseTo(v.re, 9)
      expect(again.im).toBeCloseTo(v.im, 9)
      expect(again.dim).toEqual(v.dim)
    }
    expect(literal(calculate('3 - 4j', {}, true).value)).toBe('(3-4j)')
  })
})
