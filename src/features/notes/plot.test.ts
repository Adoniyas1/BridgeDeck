import { describe, expect, it } from 'vitest'
import { evalExpr, parseExpr, pathOf, plot, ticks } from './plot'

const at = (text: string, x: number) => evalExpr(parseExpr(text), x)

describe('graph expressions', () => {
  it('reads calculator-style expressions', () => {
    expect(at('x^2 - 2x + 1', 3)).toBe(4)
    expect(at('2x', 5)).toBe(10)
    expect(at('3(x+1)', 1)).toBe(6)
    expect(at('-x^2', 3)).toBe(-9)
    expect(at('2^-x', 1)).toBe(0.5)
    expect(at('x sin(x)', Math.PI / 2)).toBeCloseTo(Math.PI / 2)
    expect(at('sin x', Math.PI / 2)).toBeCloseTo(1)
    expect(at('2pi', 0)).toBeCloseTo(2 * Math.PI)
    expect(at('e^(-x/3) * cos(2pix)', 0)).toBe(1)
    expect(at('sqrt(abs(x))', -16)).toBe(4)
    expect(at('x**3', 2)).toBe(8)
    expect(at('1/2x', 4)).toBe(2)
    expect(at('ln(e)', 0)).toBe(1)
    expect(at('log(1000)', 0)).toBeCloseTo(3)
  })

  it('says what it can’t read', () => {
    expect(() => parseExpr('2 + (x')).toThrow('bracket')
    expect(() => parseExpr('foo(x)')).toThrow('Unknown name')
    expect(() => parseExpr('2 $ x')).toThrow('$')
  })
})

describe('graph blocks', () => {
  it('reads functions and ranges', () => {
    const p = plot('y = sin(x)\nf(x) = x^2\n3x + 1\nx: -pi..2pi\ny: -2..2\n# a comment', 10)
    expect(p.curves.map(c => [c.name, c.source])).toEqual([['y', 'sin(x)'], ['f', 'x^2'], ['f3', '3x + 1']])
    expect(p.x[0]).toBeCloseTo(-Math.PI)
    expect(p.x[1]).toBeCloseTo(2 * Math.PI)
    expect(p.y).toEqual([-2, 2])
    expect(p.curves[0].points).toHaveLength(11)
    expect(p.errors).toEqual([])
  })

  it('chooses a y range without the spikes, and breaks curves at gaps', () => {
    const p = plot('y = tan(x)\nx: -3..3', 600)
    expect(p.y[1]).toBeLessThan(100)
    const d = pathOf(p.curves[0], p, 400, 300)
    expect(d.split('M').length - 1).toBeGreaterThanOrEqual(3)
    const root = plot('sqrt(x)\nx: -4..4', 8)
    expect(root.curves[0].points.slice(0, 4)).toEqual([null, null, null, null])
    expect(plot('y = 2 +').errors[0]).toMatch(/^y: /)
  })

  it('puts grid lines at round numbers', () => {
    expect(ticks(-10, 10, 4)).toEqual([-10, -5, 0, 5, 10])
    expect(ticks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  })
})

describe('measured points', () => {
  it('reads data lines and fits the axes to them', async () => {
    const { plot } = await import('./plot')
    const p = plot('Vout = 12x/(4.7 + x)\nmeasured: 1, 2.1; 4.7, 6.0; 10, 8.05\nx: 0..12')
    expect(p.curves).toHaveLength(1)
    expect(p.data).toEqual([{ name: 'measured', points: [[1, 2.1], [4.7, 6], [10, 8.05]] }])
    expect(p.x).toEqual([0, 12])
    const q = plot('data: (0, 1) (10, 5)')
    expect(q.data[0].points).toEqual([[0, 1], [10, 5]])
    expect(q.x[0]).toBeLessThan(0); expect(q.x[1]).toBeGreaterThan(10)
    expect(plot('x: -5..5').data).toEqual([])
  })
})
