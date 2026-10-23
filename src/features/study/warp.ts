/** Straightening a photo of a page: the four corners the user marks are mapped onto a flat
 *  rectangle (a perspective transform), and the paper is whitened so the writing stands out. */

export type Pt = { x: number; y: number }

/** The 3×3 perspective transform taking `from[i]` to `to[i]` (four points each), as 8 numbers
 *  (the last is 1), or null when the points don't make a shape. */
export function homography(from: Pt[], to: Pt[]): number[] | null {
  const a: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let best = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[best][c])) best = r
    if (Math.abs(a[best][c]) < 1e-12) return null
    ;[a[c], a[best]] = [a[best], a[c]]
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = a[r][c] / a[c][c]
      for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k]
    }
  }
  return a.map((row, i) => row[8] / row[i])
}

export function apply(h: number[], p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + 1
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

/** The output size for the corners (top-left, top-right, bottom-right, bottom-left): the longer
 *  of each pair of opposite sides, at most `max` pixels on the long side. */
export function outputSize(c: Pt[], max = 2200): { width: number; height: number } {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  let width = Math.max(d(c[0], c[1]), d(c[3], c[2])), height = Math.max(d(c[0], c[3]), d(c[1], c[2]))
  const k = Math.min(1, max / Math.max(width, height))
  width = Math.max(1, Math.round(width * k)); height = Math.max(1, Math.round(height * k))
  return { width, height }
}

/** The page cut out and flattened: each output pixel is read from where it came from in the
 *  photo (bilinear, so edges stay smooth). RGBA in, RGBA out. */
export function warp(src: { data: Uint8ClampedArray; width: number; height: number }, corners: Pt[], width: number, height: number): Uint8ClampedArray {
  const back = homography([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }], corners)
  const out = new Uint8ClampedArray(width * height * 4)
  if (!back) return out
  const { data, width: sw, height: sh } = src
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = apply(back, { x: x + 0.5, y: y + 0.5 })
      const fx = Math.min(sw - 1.001, Math.max(0, p.x - 0.5)), fy = Math.min(sh - 1.001, Math.max(0, p.y - 0.5))
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
      const o = (y * width + x) * 4
      for (let ch = 0; ch < 4; ch++) {
        const at = (xx: number, yy: number) => data[(yy * sw + xx) * 4 + ch]
        out[o + ch] = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
      }
    }
  }
  return out
}

/** Paper made white and ink kept dark: each pixel divided by the paper's brightness around it
 *  (the brightest in its block, smoothed), which also evens out shadows. In place. */
export function whiten(img: { data: Uint8ClampedArray; width: number; height: number }, block = 32) {
  const { data, width, height } = img
  const bw = Math.ceil(width / block), bh = Math.ceil(height / block)
  const paper = new Float32Array(bw * bh)
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    // A high percentile rather than the maximum, so a speck of glare doesn't count as paper.
    const values: number[] = []
    for (let y = by * block; y < Math.min(height, (by + 1) * block); y += 2) for (let x = bx * block; x < Math.min(width, (bx + 1) * block); x += 2) {
      const o = (y * width + x) * 4
      values.push(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2])
    }
    values.sort((a, b) => a - b)
    paper[by * bw + bx] = Math.max(60, values[Math.floor(values.length * 0.9)] ?? 255)
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Paper brightness here, blended between the nearest block centres.
    const gx = Math.min(bw - 1, Math.max(0, x / block - 0.5)), gy = Math.min(bh - 1, Math.max(0, y / block - 0.5))
    const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1), tx = gx - x0, ty = gy - y0
    const p = (paper[y0 * bw + x0] * (1 - tx) + paper[y0 * bw + x1] * tx) * (1 - ty) + (paper[y1 * bw + x0] * (1 - tx) + paper[y1 * bw + x1] * tx) * ty
    const o = (y * width + x) * 4
    for (let ch = 0; ch < 3; ch++) {
      const v = Math.min(1, data[o + ch] / p)
      // A curve that pushes near-white to white and keeps the ink's darkness.
      data[o + ch] = Math.round(255 * (v > 0.85 ? 1 : Math.pow(v / 0.85, 1.6)))
    }
  }
}

/** A starting guess for the corners: the page inset a little from the photo's edges. */
export const defaultCorners = (w: number, h: number): Pt[] => [{ x: w * 0.04, y: h * 0.04 }, { x: w * 0.96, y: h * 0.04 }, { x: w * 0.96, y: h * 0.96 }, { x: w * 0.04, y: h * 0.96 }]
