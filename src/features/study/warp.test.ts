import { describe, expect, it } from 'vitest'
import { apply, findCorners, homography, outputSize, warp, whiten } from './warp'

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
  it('finds a tilted page on a dark desk', () => {
    const w = 200, h = 150
    const gray = new Uint8Array(w * h).fill(40)
    const page = [{ x: 30, y: 20 }, { x: 170, y: 35 }, { x: 160, y: 135 }, { x: 25, y: 120 }]
    // Fill the quad (with a little noise and some dark writing inside).
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hit = false
      for (let i = 0, j = 3; i < 4; j = i++) { const a = page[i], b = page[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit }
      if (hit) gray[y * w + x] = (x % 17 === 0 && y % 3 === 0) ? 60 : 225 + ((x * 7 + y * 3) % 20)
    }
    const found = findCorners(gray, w, h)!
    expect(found).not.toBeNull()
    found.forEach((p, i) => expect(Math.hypot(p.x - page[i].x, p.y - page[i].y)).toBeLessThan(4))
  })
  it('gives up on a photo with no page in it', () => {
    expect(findCorners(new Uint8Array(100 * 100).fill(200), 100, 100)).toBeNull()
    const speck = new Uint8Array(100 * 100).fill(30); speck[5050] = 250
    expect(findCorners(speck, 100, 100)).toBeNull()
  })
})
