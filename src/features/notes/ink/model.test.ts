import { describe, expect, it } from 'vitest'
import { compacted, decodePoints, encodePoints, eraseLine, mergeLogs, readDoc, strokeLine, type Stroke } from './model'

const stroke = (id: string, t: number, page = 0): Stroke => ({ id, page, t, tool: 'pen', color: '#112233', width: 2, points: [{ x: 10, y: 20.25, p: 0.5 }, { x: 11.5, y: 21, p: 0.62 }] })

describe('ink model', () => {
  it('encodes points compactly and back', () => {
    const text = encodePoints(stroke('a', 1).points)
    expect(text).toBe('100,203,50;15,7,12')
    expect(decodePoints(text)).toEqual([{ x: 10, y: 20.3, p: 0.5 }, { x: 11.5, y: 21, p: 0.62 }])
  })
  it('merges devices, applies erasures and skips cut-off lines', () => {
    const mac = [strokeLine(stroke('a', 1)), strokeLine(stroke('b', 3)), eraseLine(['c'], 5)]
    const ipad = [strokeLine(stroke('c', 2)), strokeLine(stroke('d', 4)), '{"s":"e","p":"1,2']
    expect(mergeLogs([['mac', mac], ['ipad', ipad]]).map(s => s.id)).toEqual(['a', 'b', 'd'])
  })
  it('reads the page setup with defaults', () => {
    expect(readDoc('{"paper":"grid","size":"a4","pages":3}')).toEqual({ v: 1, paper: 'grid', size: 'a4', pages: 3 })
    expect(readDoc('nonsense')).toEqual({ v: 1, paper: 'lines', size: 'letter', pages: 1 })
  })
  it('compacts its own log but keeps erasures of others', () => {
    const own = [...Array.from({ length: 12 }, (_, i) => strokeLine(stroke(`m${i}`, i))), eraseLine(Array.from({ length: 12 }, (_, i) => `m${i}`)), eraseLine(['ipad1'])]
    const all = mergeLogs([['mac', own]])
    expect(compacted(own, all)).toEqual([eraseLine(['ipad1'], JSON.parse(own[13]).t)])
    expect(compacted([strokeLine(stroke('x', 1))], mergeLogs([['m', [strokeLine(stroke('x', 1))]]]))).toBeNull()
  })
})

describe('ink drawing helpers', () => {
  it('makes an outline path and hits strokes for the eraser', async () => {
    const { strokePath, touches } = await import('./render')
    const s = stroke('a', 1)
    expect(strokePath(s)).toMatch(/^M [\d.]+,[\d.]+ Q .* Z$/)
    expect(touches(s, { x: 10.5, y: 20.5, p: 0 }, 2)).toBe(true)
    expect(touches(s, { x: 40, y: 60, p: 0 }, 2)).toBe(false)
  })
})
