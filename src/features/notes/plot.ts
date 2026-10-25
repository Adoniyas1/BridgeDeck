/** Graph blocks in notes: functions of x written like a calculator, plotted over a range.
 *
 *    y = sin(x)
 *    f(x) = x^2 - 2x + 1
 *    g = 2e^(-x/3) * cos(2pi x)
 *    x: -10..10
 *    y: -2..2
 *    measured: 1, 2.1; 4.7, 6.0; 10, 8.05
 *
 *  A line of x, y pairs (after a name and a colon) is data, drawn as points: a lab's measurements
 *  over the theory's curve.
 *
 *  Expressions are read here (the page can't run code it builds): numbers, x, + - * / ^, brackets,
 *  implied multiplication (2x, 3(x+1), x sin(x)), pi and e, and the usual functions. */

type Node =
  | { t: 'num'; v: number }
  | { t: 'x' }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'fn'; name: string; a: Node }

const FUNCTIONS: Record<string, (v: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, log2: Math.log2, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sign: Math.sign, sec: v => 1 / Math.cos(v), csc: v => 1 / Math.sin(v), cot: v => 1 / Math.tan(v),
}
const CONSTANTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E, tau: 2 * Math.PI }

type Token = { k: 'num'; v: number } | { k: 'name'; v: string } | { k: 'op'; v: string }

function tokenize(text: string): Token[] {
  const out: Token[] = []
  let i = 0
  const src = text.replace(/·|×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    const num = src.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i)
    if (num && /[\d.]/.test(c)) { out.push({ k: 'num', v: Number(num[0]) }); i += num[0].length; continue }
    const name = src.slice(i).match(/^[a-zA-Zπ][a-zA-Z0-9]*/)
    if (name) {
      // "2pix" or "sinx": split a run of letters into known names where it can be.
      let word = name[0].toLowerCase()
      while (word) {
        const known = [...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS), 'x'].filter(k => word.startsWith(k)).sort((a, b) => b.length - a.length)[0]
        if (!known) throw new Error(`Unknown name “${word}”`)
        out.push({ k: 'name', v: known })
        word = word.slice(known.length)
      }
      i += name[0].length
      continue
    }
    if ('+-*/^()'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue }
    throw new Error(`Can’t read “${c}”`)
  }
  return out
}

/** Reads an expression in x. */
export function parseExpr(text: string): Node {
  const tokens = tokenize(text.replace(/\*\*/g, '^'))
  let i = 0
  const peek = () => tokens[i]
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v
  const expect = (v: string) => { if (!isOp(v)) throw new Error(v === ')' ? 'A bracket isn’t closed' : `Expected ${v}`); i++ }
  // A token that can start a factor directly after another one: implied multiplication.
  const startsFactor = () => { const t = peek(); return !!t && (t.k === 'num' || t.k === 'name' || (t.k === 'op' && t.v === '(')) }

  function sum(): Node {
    let a = product()
    while (isOp('+') || isOp('-')) { const op = (tokens[i++] as { v: '+' | '-' }).v; a = { t: 'bin', op, a, b: product() } }
    return a
  }
  function product(): Node {
    let a = unary()
    for (;;) {
      if (isOp('*') || isOp('/')) { const op = (tokens[i++] as { v: '*' | '/' }).v; a = { t: 'bin', op, a, b: unary() } }
      else if (startsFactor()) a = { t: 'bin', op: '*', a, b: power() }
      else return a
    }
  }
  function unary(): Node {
    if (isOp('-')) { i++; return { t: 'neg', a: unary() } }
    if (isOp('+')) { i++; return unary() }
    return power()
  }
  function power(): Node {
    const base = atom()
    if (isOp('^')) { i++; return { t: 'bin', op: '^', a: base, b: unary() } }
    return base
  }
  function atom(): Node {
    const t = peek()
    if (!t) throw new Error('The expression ends too soon')
    if (t.k === 'num') { i++; return { t: 'num', v: t.v } }
    if (t.k === 'op' && t.v === '(') { i++; const inner = sum(); expect(')'); return inner }
    if (t.k === 'name') {
      i++
      if (t.v === 'x') return { t: 'x' }
      if (t.v in CONSTANTS) return { t: 'num', v: CONSTANTS[t.v] }
      // sin x, sin(x), sin^2 x is not supported: sin(x)^2.
      if (isOp('(')) { i++; const a = sum(); expect(')'); return { t: 'fn', name: t.v, a } }
      return { t: 'fn', name: t.v, a: power() }
    }
    throw new Error(`Unexpected “${t.v}”`)
  }
  const tree = sum()
  if (i < tokens.length) throw new Error(`Unexpected “${(tokens[i] as { v: unknown }).v}”`)
  return tree
}

export function evalExpr(n: Node, x: number): number {
  switch (n.t) {
    case 'num': return n.v
    case 'x': return x
    case 'neg': return -evalExpr(n.a, x)
    case 'fn': return FUNCTIONS[n.name](evalExpr(n.a, x))
    case 'bin': {
      const a = evalExpr(n.a, x), b = evalExpr(n.b, x)
      return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : Math.pow(a, b)
    }
  }
}

export type Curve = { name: string; source: string; points: Array<[number, number] | null> }
export type PointSet = { name: string; points: Array<[number, number]> }
export type Plot = { curves: Curve[]; data: PointSet[]; x: [number, number]; y: [number, number]; errors: string[] }

/** "name: x, y; x, y; …" → the points, or null when the line isn't data. */
function dataLine(line: string): PointSet | null {
  const m = line.match(/^([a-zA-Z][\w ]{0,20}?)\s*:\s*(.+)$/)
  if (!m || !m[2].includes(',')) return null
  const pairs = m[2].split(/;|\)\s*\(/).map(p => p.replace(/[()]/g, '').split(',').map(s => Number(s.trim())))
  if (!pairs.length || pairs.some(p => p.length !== 2 || !p.every(Number.isFinite))) return null
  return { name: m[1].trim(), points: pairs.map(([a, b]) => [a, b] as [number, number]) }
}

const RANGE = /^([xy])\s*(?::|=|in)\s*\[?\s*(-?[\d.]+(?:e-?\d+)?|-?pi|-?\d*\.?\d*pi)\s*(?:\.\.|,|to)\s*(-?[\d.]+(?:e-?\d+)?|-?pi|-?\d*\.?\d*pi)\s*\]?$/i

const number = (text: string) => {
  const m = text.toLowerCase().match(/^(-?)(\d*\.?\d*)pi$/)
  return m ? (m[1] ? -1 : 1) * (m[2] ? Number(m[2]) : 1) * Math.PI : Number(text)
}

/** Reads a graph block and samples each function across the x range. The y range is chosen
 *  from the values (ignoring spikes) unless given. */
export function plot(text: string, samples = 400): Plot {
  let x: [number, number] | null = null
  let y: [number, number] | null = null
  const errors: string[] = []
  const data: PointSet[] = []
  const exprs: Array<{ name: string; source: string; node: Node }> = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const range = line.match(RANGE)
    if (range) {
      const [lo, hi] = [number(range[2]), number(range[3])]
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) { if (range[1].toLowerCase() === 'x') x = [lo, hi]; else y = [lo, hi] }
      else errors.push(`The range “${line}” needs a smaller number first.`)
      continue
    }
    const points = dataLine(line)
    if (points) { if (data.length < 8) data.push(points); continue }
    const m = line.match(/^([a-zA-Z]\w{0,8})(?:\(x\))?\s*=\s*(.+)$/)
    const [name, source] = m ? [m[1], m[2]] : [`f${exprs.length + 1}`, line]
    try { exprs.push({ name, source, node: parseExpr(source) }) } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  // Without a range, the x axis spans the data (with a margin), or -10..10.
  if (!x) {
    const xs = data.flatMap(d => d.points.map(p => p[0]))
    const [lo, hi] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [-10, 10]
    const pad = (hi - lo) * 0.08 || 1
    x = xs.length ? [lo - pad, hi + pad] : [lo, hi]
  }
  const span = x
  const curves: Curve[] = exprs.slice(0, 8).map(({ name, source, node }) => ({
    name, source,
    points: Array.from({ length: samples + 1 }, (_, i) => {
      const px = span[0] + (span[1] - span[0]) * (i / samples)
      const py = evalExpr(node, px)
      return Number.isFinite(py) ? [px, py] as [number, number] : null
    }),
  }))
  if (!y) {
    const values = [...curves.flatMap(c => c.points.flatMap(p => (p ? [p[1]] : []))), ...data.flatMap(d => d.points.map(p => p[1]))].sort((a, b) => a - b)
    if (values.length) {
      // The middle 96% of values, so an asymptote doesn't flatten everything else.
      const lo = values[Math.floor(values.length * 0.02)], hi = values[Math.ceil(values.length * 0.98) - 1]
      const pad = (hi - lo) * 0.08 || 1
      y = [lo - pad, hi + pad]
    } else y = [-10, 10]
  }
  return { curves, data, x, y, errors }
}

/** Grid steps of 1, 2 or 5 × a power of ten, about `count` across a span. */
export function ticks(lo: number, hi: number, count = 8): number[] {
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map(s => s * mag).find(s => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)))
  return out
}

/** SVG path data for a curve in a w × h box, broken at gaps and at jumps off the chart
 *  (tan x's asymptotes don't draw vertical lines). */
export function pathOf(curve: Curve, p: Plot, w: number, h: number): string {
  const sx = (v: number) => ((v - p.x[0]) / (p.x[1] - p.x[0])) * w
  const sy = (v: number) => h - ((v - p.y[0]) / (p.y[1] - p.y[0])) * h
  let d = ''
  let last: [number, number] | null = null
  for (const point of curve.points) {
    if (!point) { last = null; continue }
    const [px, py] = [sx(point[0]), sy(point[1])]
    const far = Math.abs(py) > h * 50
    if (far || (last && Math.abs(py - last[1]) > h * 1.5 && (py < 0 || py > h || last[1] < 0 || last[1] > h))) { last = far ? null : [px, py]; if (!far) d += ` M${px.toFixed(1)},${py.toFixed(1)}`; continue }
    d += `${last ? ' L' : ' M'}${px.toFixed(1)},${py.toFixed(1)}`
    last = [px, py]
  }
  return d.trim()
}

/** A graph block drawn as a standalone SVG (for the typeset PDF): axes, grid, curves and the
 *  measured points, in colours that print. */
export function graphSvg(text: string, W = 560, H = 300): string | null {
  const p = plot(text)
  if (!p.curves.length && !p.data.length) return null
  const PAD = 40, w = W - PAD - 14, h = H - 40
  const colors = ['#1d4ed8', '#b91c1c', '#15803d', '#a16207', '#7e22ce', '#0f766e']
  const sx = (v: number) => PAD + ((v - p.x[0]) / (p.x[1] - p.x[0])) * w
  const sy = (v: number) => h - ((v - p.y[0]) / (p.y[1] - p.y[0])) * h
  const num = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(0) : String(Number(v.toPrecision(4))))
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="10">`, `<rect width="${W}" height="${H}" fill="white"/>`]
  for (const v of ticks(p.x[0], p.x[1])) out.push(`<line x1="${sx(v).toFixed(1)}" y1="0" x2="${sx(v).toFixed(1)}" y2="${h}" stroke="${v === 0 ? '#555' : '#ddd'}"/>`, `<text x="${sx(v).toFixed(1)}" y="${h + 14}" text-anchor="middle" fill="#333">${num(v)}</text>`)
  for (const v of ticks(p.y[0], p.y[1], 6)) out.push(`<line x1="${PAD}" y1="${sy(v).toFixed(1)}" x2="${PAD + w}" y2="${sy(v).toFixed(1)}" stroke="${v === 0 ? '#555' : '#ddd'}"/>`, `<text x="${PAD - 4}" y="${(sy(v) + 3).toFixed(1)}" text-anchor="end" fill="#333">${num(v)}</text>`)
  out.push(`<clipPath id="c"><rect x="${PAD}" y="0" width="${w}" height="${h}"/></clipPath><g clip-path="url(#c)">`)
  p.curves.forEach((c, i) => { const d = pathOf(c, p, w, h); if (d) out.push(`<path transform="translate(${PAD},0)" d="${d}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="2"/>`) })
  p.data.forEach((d, i) => d.points.forEach(([x, y]) => out.push(`<circle cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="3.5" fill="${colors[(p.curves.length + i) % colors.length]}"/>`)))
  out.push('</g>')
  // The legend under the axis numbers.
  let lx = PAD
  const legend = [...p.curves.map((c, i) => ({ text: `${c.name} = ${c.source}`, color: colors[i % colors.length], dot: false })), ...p.data.map((d, i) => ({ text: d.name, color: colors[(p.curves.length + i) % colors.length], dot: true }))]
  for (const item of legend) {
    out.push(item.dot ? `<circle cx="${lx + 4}" cy="${h + 30}" r="3.5" fill="${item.color}"/>` : `<line x1="${lx}" y1="${h + 30}" x2="${lx + 12}" y2="${h + 30}" stroke="${item.color}" stroke-width="2"/>`, `<text x="${lx + 16}" y="${h + 33}" fill="#222">${esc(item.text)}</text>`)
    lx += 26 + item.text.length * 5.5
  }
  out.push('</svg>')
  return out.join('')
}
