/** Handwriting as data: strokes of points in page coordinates (points, 1/72 inch; Letter is
 *  612×792), with pressure. Each device appends to its own log (src-tauri/src/ink.rs); a document is
 *  every device's log merged: strokes in time order, minus the ones an erasure removed.
 *
 *  A log line is one of:
 *    {"s": id, "pg": page, "t": ms, "tool": "pen"|"hl", "c": "#rrggbb", "w": width, "p": "x,y,p;dx,dy,dp;…"}
 *    {"e": [ids], "t": ms}            (erased)
 *  Points are tenths of a point and pressure 0-100, each after the first as the change from the last. */

export type Point = { x: number; y: number; p: number }
export type Tool = 'pen' | 'hl'
export type Stroke = { id: string; page: number; t: number; tool: Tool; color: string; width: number; points: Point[] }
export type Paper = 'blank' | 'lines' | 'grid' | 'dots' | 'pdf'
export type InkDoc = { v: 1; paper: Paper; size: 'letter' | 'a4'; pages: number; title?: string; /** A PDF written on: its course and file. */ pdf?: { course: string; file: string } }

export const PAGE_SIZES = { letter: [612, 792], a4: [595, 842] } as const
export const newDoc = (paper: Paper = 'lines', size: InkDoc['size'] = 'letter'): InkDoc => ({ v: 1, paper, size, pages: 1 })

export function readDoc(text: string | null | undefined): InkDoc {
  try {
    const d = JSON.parse(text ?? '') as Partial<InkDoc>
    return {
      v: 1, paper: (['blank', 'lines', 'grid', 'dots', 'pdf'] as const).includes(d.paper as Paper) ? d.paper as Paper : 'lines',
      size: d.size === 'a4' ? 'a4' : 'letter', pages: Number.isInteger(d.pages) && d.pages! >= 1 ? Math.min(d.pages!, 2000) : 1,
      ...(typeof d.title === 'string' ? { title: d.title.slice(0, 120) } : {}),
      ...(d.pdf && typeof d.pdf.course === 'string' && typeof d.pdf.file === 'string' ? { pdf: { course: d.pdf.course, file: d.pdf.file } } : {}),
    }
  } catch { return newDoc() }
}

export function encodePoints(points: Point[]): string {
  let last = { x: 0, y: 0, p: 0 }
  return points.map((pt, i) => {
    const cur = { x: Math.round(pt.x * 10), y: Math.round(pt.y * 10), p: Math.round(Math.max(0, Math.min(1, pt.p)) * 100) }
    const out = i === 0 ? cur : { x: cur.x - last.x, y: cur.y - last.y, p: cur.p - last.p }
    last = cur
    return `${out.x},${out.y},${out.p}`
  }).join(';')
}

export function decodePoints(text: string): Point[] {
  const out: Point[] = []
  let x = 0, y = 0, p = 0
  for (const part of text.split(';')) {
    const [a, b, c] = part.split(',').map(Number)
    if (![a, b, c].every(Number.isFinite)) return out
    if (out.length) { x += a; y += b; p += c } else { x = a; y = b; p = c }
    out.push({ x: x / 10, y: y / 10, p: p / 100 })
  }
  return out
}

export const strokeLine = (s: Stroke) => JSON.stringify({ s: s.id, pg: s.page, t: s.t, tool: s.tool, c: s.color, w: s.width, p: encodePoints(s.points) })
export const eraseLine = (ids: string[], t = Date.now()) => JSON.stringify({ e: ids, t })

/** Every device's lines merged into the strokes still there, oldest first. Lines that don't read
 *  (cut off by a sync in progress, or from a newer build) are skipped. */
export function mergeLogs(logs: Array<[string, string[]]>): Stroke[] {
  const strokes = new Map<string, Stroke>()
  const erased = new Set<string>()
  for (const [, lines] of logs) {
    for (const line of lines) {
      let v: Record<string, unknown>
      try { v = JSON.parse(line) } catch { continue }
      if (Array.isArray(v.e)) { for (const id of v.e) if (typeof id === 'string') erased.add(id); continue }
      if (typeof v.s !== 'string' || typeof v.p !== 'string') continue
      const points = decodePoints(v.p)
      if (!points.length) continue
      strokes.set(v.s, { id: v.s, page: Number(v.pg) || 0, t: Number(v.t) || 0, tool: v.tool === 'hl' ? 'hl' : 'pen', color: typeof v.c === 'string' && /^#[0-9a-f]{6}$/i.test(v.c) ? v.c : '#111111', width: Math.min(40, Math.max(0.3, Number(v.w) || 2)), points })
    }
  }
  return [...strokes.values()].filter(s => !erased.has(s.id)).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
}

/** This device's log with erased strokes (and erasures that no longer erase anything of its own)
 *  dropped, when it's worth rewriting: at least a fifth of it is gone. */
export function compacted(own: string[], all: Stroke[]): string[] | null {
  const alive = new Set(all.map(s => s.id))
  const kept = own.filter(line => {
    try { const v = JSON.parse(line); return typeof v.s === 'string' ? alive.has(v.s) : Array.isArray(v.e) ? false : false } catch { return false }
  })
  // Erasures of other devices' strokes must stay: they're what removes those.
  const othersErased = own.filter(line => { try { const v = JSON.parse(line); return Array.isArray(v.e) && v.e.some((id: unknown) => typeof id === 'string' && !own.some(l => l.includes(`"s":"${id}"`))) } catch { return false } })
  const result = [...kept, ...othersErased]
  return own.length - result.length >= Math.max(10, own.length / 5) ? result : null
}

export const newStrokeId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
