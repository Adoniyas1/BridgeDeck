import { getStroke } from 'perfect-freehand'
import { PAGE_SIZES, type InkDoc, type Point, type Stroke } from './model'

/** A stroke's outline as an SVG path (page coordinates), shaped by pressure. */
export function strokePath(s: Pick<Stroke, 'points' | 'width' | 'tool'>, live = false): string {
  const outline = getStroke(s.points.map(p => [p.x, p.y, p.p] as [number, number, number]), {
    size: s.tool === 'hl' ? s.width * 6 : s.width * 2,
    thinning: s.tool === 'hl' ? 0 : 0.55,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: s.points.every(p => p.p === 0.5),
    last: !live,
  })
  if (!outline.length) return ''
  const f = (n: number) => Math.round(n * 100) / 100
  const d = outline.reduce((acc, [x0, y0], i, arr) => {
    const [x1, y1] = arr[(i + 1) % arr.length]
    acc.push(`${f(x0)},${f(y0)} ${f((x0 + x1) / 2)},${f((y0 + y1) / 2)}`)
    return acc
  }, ['M', `${f(outline[0][0])},${f(outline[0][1])}`, 'Q'])
  return `${d.join(' ')} Z`
}

export const pageSize = (doc: InkDoc) => PAGE_SIZES[doc.size]

/** The paper's lines, grid or dots on a page (drawn under the ink). */
export function drawPaper(ctx: CanvasRenderingContext2D, doc: InkDoc, scale: number) {
  const [w, h] = pageSize(doc)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w * scale, h * scale)
  ctx.strokeStyle = '#c9d6e8'
  ctx.fillStyle = '#b6c3d6'
  ctx.lineWidth = Math.max(0.5, 0.6 * scale)
  const step = 24
  if (doc.paper === 'lines') {
    for (let y = 72; y < h - 24; y += step) { ctx.beginPath(); ctx.moveTo(36 * scale, y * scale); ctx.lineTo((w - 36) * scale, y * scale); ctx.stroke() }
    ctx.strokeStyle = '#efb0b0'
    ctx.beginPath(); ctx.moveTo(72 * scale, 0); ctx.lineTo(72 * scale, h * scale); ctx.stroke()
  } else if (doc.paper === 'grid') {
    for (let x = 18; x < w; x += 18) { ctx.beginPath(); ctx.moveTo(x * scale, 0); ctx.lineTo(x * scale, h * scale); ctx.stroke() }
    for (let y = 18; y < h; y += 18) { ctx.beginPath(); ctx.moveTo(0, y * scale); ctx.lineTo(w * scale, y * scale); ctx.stroke() }
  } else if (doc.paper === 'dots') {
    for (let x = 18; x < w; x += 18) for (let y = 18; y < h; y += 18) ctx.fillRect(x * scale - scale * 0.6, y * scale - scale * 0.6, scale * 1.2, scale * 1.2)
  }
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale: number) {
  ctx.save()
  ctx.scale(scale, scale)
  for (const s of strokes) {
    const path = new Path2D(strokePath(s))
    ctx.globalAlpha = s.tool === 'hl' ? 0.35 : 1
    ctx.fillStyle = s.color
    ctx.fill(path)
  }
  ctx.restore()
}

/** Whether a point (page coordinates) is within `radius` of a stroke: for the eraser. */
export function touches(s: Stroke, at: Point, radius: number) {
  const r = radius + s.width
  for (let i = 0; i < s.points.length; i++) {
    const a = s.points[i], b = s.points[Math.min(i + 1, s.points.length - 1)]
    const dx = b.x - a.x, dy = b.y - a.y
    const len = dx * dx + dy * dy
    const t = len ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / len)) : 0
    if (Math.hypot(a.x + t * dx - at.x, a.y + t * dy - at.y) <= r) return true
  }
  return false
}

/** Page scale: the page's own size × 1.5 when there's room, smaller to fit the width there is
 *  (16 px of margin each side). Strokes are kept in page units, so the scale can change freely. */
export const fitScale = (available: number, pageWidth: number) => Math.max(0.4, Math.min(1.5, (available - 32) / pageWidth))
