import { describe, expect, it } from 'vitest'
import { apply, homography, outputSize, warp, whiten } from './warp'

describe('straightening a page photo', () => {
  it('maps four corners exactly', () => {
    const from = [{ x: 10, y: 20 }, { x: 300, y: 5 }, { x: 320, y: 400 }, { x: 0, y: 380 }]
    const to = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 150 }, { x: 0, y: 150 }]
    const h = homography(from, to)!
    from.forEach((p, i) => { const q = apply(h, p); expect(q.x).toBeCloseTo(to[i].x, 6); expect(q.y).toBeCloseTo(to[i].y, 6) })
    expect(homography([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], to)).toBeNull()
    expect(outputSize(from)).toEqual({ width: 321, height: 396 })
  })
  it('cuts out the marked area and whitens paper', () => {
    // A 4×4 photo: the left half dark, the right half grey paper.
    const data = new Uint8ClampedArray(4 * 4 * 4)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const v = x < 2 ? 20 : 180; data.set([v, v, v, 255], (y * 4 + x) * 4) }
    const out = warp({ data, width: 4, height: 4 }, [{ x: 2, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 2, y: 4 }], 2, 4)
    expect(out[0]).toBeGreaterThan(150)
    const page = { data: new Uint8ClampedArray(data), width: 4, height: 4 }
    whiten(page, 4)
    expect(page.data[(0 * 4 + 3) * 4]).toBe(255)
    expect(page.data[0]).toBeLessThan(20)
  })
})
