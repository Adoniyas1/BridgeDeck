/** A small circuit solver for checking homework: a SPICE-style netlist solved by modified nodal
 *  analysis, at DC or at one frequency (complex, so phasors come out). Values take units and
 *  prefixes (lib/expr.ts). Node "0" (or "gnd") is ground.
 *
 *    R1 in out 4.7k        resistor
 *    C1 out 0 10uF         capacitor (open at DC)
 *    L1 a b 2mH            inductor (a short at DC)
 *    V1 in 0 12V           voltage source (+ first); "V1 in 0 5∠30°" at AC
 *    I1 0 out 2mA          current source, flowing from the first node through it to the second
 *    .ac 1kHz              solve at this frequency (otherwise DC)
 *    ? V(out) = 3.4V       a value to check (±2%), or "? I(R1)" to show it */

import { evaluate, formatQuantity, unitName, type Quantity } from './expr'

type C = { re: number; im: number }
const c = (re: number, im = 0): C => ({ re, im })
const add = (a: C, b: C) => c(a.re + b.re, a.im + b.im)
const sub = (a: C, b: C) => c(a.re - b.re, a.im - b.im)
const mul = (a: C, b: C) => c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
const div = (a: C, b: C) => { const d = b.re * b.re + b.im * b.im; return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d) }
const mag = (a: C) => Math.hypot(a.re, a.im)

export type Part = { name: string; kind: 'R' | 'C' | 'L' | 'V' | 'I'; a: string; b: string; value: C }
export type Check = { what: string; expected?: Quantity; line: number }
export type Netlist = { parts: Part[]; freq: number | null; checks: Check[]; errors: string[] }

const isGround = (n: string) => n === '0' || n.toLowerCase() === 'gnd'

export function parseNetlist(text: string): Netlist {
  const parts: Part[] = [], checks: Check[] = [], errors: string[] = []
  let freq: number | null = null
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/[;*].*$|\/\/.*$/, '').trim()
    if (!line) return
    try {
      if (line.startsWith('?')) {
        const m = line.slice(1).trim().match(/^([VI]\([^)]+\))\s*(?:=\s*(.+))?$/i)
        if (!m) throw new Error('Write a check as ? V(node) = 3.4V or ? I(R1)')
        checks.push({ what: `${m[1][0].toUpperCase()}${m[1].slice(1)}`, expected: m[2] ? evaluate(m[2]) : undefined, line: i })
        return
      }
      if (/^\.ac\b/i.test(line)) { const f = evaluate(line.slice(3).trim()); freq = f.re; if (!(freq > 0)) throw new Error('.ac needs a frequency above 0'); return }
      if (/^\.(dc|op|end)\b/i.test(line)) return
      const [name, a, b, ...rest] = line.split(/\s+/)
      const kind = name[0].toUpperCase() as Part['kind']
      if (!'RCLVI'.includes(kind) || !a || !b || !rest.length) throw new Error(`Can’t read “${line}”: start with R, C, L, V or I, then two nodes and a value`)
      const v = evaluate(rest.join(' '))
      if (kind !== 'V' && kind !== 'I' && v.im === 0 && v.re <= 0) throw new Error(`${name} needs a value above 0`)
      parts.push({ name, kind, a: isGround(a) ? '0' : a, b: isGround(b) ? '0' : b, value: c(v.re, v.im) })
    } catch (e) { errors.push(`Line ${i + 1}: ${e instanceof Error ? e.message : String(e)}`) }
  })
  return { parts, freq, checks, errors }
}

export type Solution = { voltages: Record<string, C>; currents: Record<string, C>; freq: number | null }

/** Solves the circuit: each node's voltage (to ground) and each part's current (from its first
 *  node to its second, through the part). Throws when it has no single answer (a floating node,
 *  voltage sources in a loop). */
export function solve(net: Netlist): Solution {
  const w = net.freq ? 2 * Math.PI * net.freq : 0
  const nodes = [...new Set(net.parts.flatMap(p => [p.a, p.b]).filter(n => n !== '0'))]
  if (!nodes.length) throw new Error('No nodes besides ground')
  if (!net.parts.some(p => p.a === '0' || p.b === '0')) throw new Error('Nothing connects to ground (node 0)')
  const idx = new Map(nodes.map((n, i) => [n, i]))
  // Voltage sources, and inductors at DC (a short), add a current unknown each.
  const extra = net.parts.filter(p => p.kind === 'V' || (p.kind === 'L' && !w))
  const size = nodes.length + extra.length
  const A: C[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => c(0)))
  const z: C[] = Array.from({ length: size }, () => c(0))
  const stamp = (r: number, col: number, v: C) => { if (r >= 0 && col >= 0) A[r][col] = add(A[r][col], v) }
  const at = (n: string) => n === '0' ? -1 : idx.get(n)!
  for (const p of net.parts) {
    const [i, j] = [at(p.a), at(p.b)]
    let y: C | null = null
    if (p.kind === 'R') y = div(c(1), p.value)
    else if (p.kind === 'C') y = w ? mul(c(0, w), p.value) : null
    else if (p.kind === 'L' && w) y = div(c(1), mul(c(0, w), p.value))
    if (y) { stamp(i, i, y); stamp(j, j, y); stamp(i, j, c(-y.re, -y.im)); stamp(j, i, c(-y.re, -y.im)) }
    if (p.kind === 'I') { if (i >= 0) z[i] = sub(z[i], p.value); if (j >= 0) z[j] = add(z[j], p.value) }
  }
  extra.forEach((p, k) => {
    const r = nodes.length + k, [i, j] = [at(p.a), at(p.b)]
    stamp(i, r, c(1)); stamp(j, r, c(-1)); stamp(r, i, c(1)); stamp(r, j, c(-1))
    z[r] = p.kind === 'V' ? p.value : c(0)
  })
  // A tiny conductance to ground on every node keeps open circuits (a capacitor at DC) solvable;
  // it's far below any real part, so answers don't change.
  for (let k = 0; k < nodes.length; k++) A[k][k] = add(A[k][k], c(1e-12))
  const x = gauss(A, z)
  const V = (n: string) => n === '0' ? c(0) : x[idx.get(n)!]
  const voltages = Object.fromEntries(nodes.map(n => [n, V(n)]))
  const currents: Record<string, C> = {}
  for (const p of net.parts) {
    const drop = sub(V(p.a), V(p.b))
    const k = extra.indexOf(p)
    if (k >= 0) currents[p.name] = p.kind === 'V' ? c(-x[nodes.length + k].re, -x[nodes.length + k].im) : x[nodes.length + k]
    else if (p.kind === 'R') currents[p.name] = div(drop, p.value)
    else if (p.kind === 'C') currents[p.name] = w ? mul(drop, mul(c(0, w), p.value)) : c(0)
    else if (p.kind === 'L') currents[p.name] = div(drop, mul(c(0, w), p.value))
    else if (p.kind === 'I') currents[p.name] = p.value
  }
  return { voltages, currents, freq: net.freq }
}

function gauss(A: C[][], z: C[]): C[] {
  const n = z.length
  const M = A.map((row, i) => [...row, z[i]])
  for (let col = 0; col < n; col++) {
    let best = col
    for (let r = col + 1; r < n; r++) if (mag(M[r][col]) > mag(M[best][col])) best = r
    if (mag(M[best][col]) < 1e-18) throw new Error('This circuit has no single answer: check for voltage sources in a loop, or a source with nothing across it')
    ;[M[col], M[best]] = [M[best], M[col]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = div(M[r][col], M[col][col])
      if (f.re === 0 && f.im === 0) continue
      for (let k = col; k <= n; k++) M[r][k] = sub(M[r][k], mul(f, M[col][k]))
    }
  }
  return M.map((row, i) => div(row[n], row[i]))
}

const VOLT: Quantity['dim'] = [2, 1, -3, -1], AMP: Quantity['dim'] = [0, 0, 0, 1]

/** A solved value as a quantity with its unit. */
export function valueOf(sol: Solution, what: string): Quantity | null {
  const m = what.match(/^([VI])\((.+)\)$/i)
  if (!m) return null
  const key = m[2]
  if (m[1].toUpperCase() === 'V') {
    if (key === '0' || key.toLowerCase() === 'gnd') return { re: 0, im: 0, dim: VOLT }
    const node = Object.keys(sol.voltages).find(n => n.toLowerCase() === key.toLowerCase())
    return node ? { ...sol.voltages[node], dim: VOLT } : null
  }
  const name = Object.keys(sol.currents).find(n => n.toLowerCase() === key.toLowerCase())
  return name ? { ...sol.currents[name], dim: AMP } : null
}

export type CheckResult = { what: string; line: number; shown?: string; right?: boolean; message: string }

/** Each "?" line answered: right or wrong against the solution (within 2%), and the value itself
 *  unless `checkOnly` (graded work: only whether the user's own value is right). */
export function runChecks(net: Netlist, sol: Solution, checkOnly: boolean): CheckResult[] {
  return net.checks.map(ch => {
    const value = valueOf(sol, ch.what)
    if (!value) return { what: ch.what, line: ch.line, message: `There’s no ${ch.what} in this circuit` }
    if (!ch.expected) return checkOnly ? { what: ch.what, line: ch.line, message: 'Write your value after = to check it (values are hidden for graded work)' } : { what: ch.what, line: ch.line, shown: formatQuantity(value), message: formatQuantity(value) }
    if (unitName(ch.expected.dim) && unitName(ch.expected.dim) !== unitName(value.dim)) return { what: ch.what, line: ch.line, right: false, message: `That’s in ${unitName(ch.expected.dim)}; ${ch.what} is in ${unitName(value.dim)}` }
    const size = Math.max(Math.hypot(value.re, value.im), 1e-15)
    const right = Math.hypot(value.re - ch.expected.re, value.im - ch.expected.im) / size <= 0.02
    return { what: ch.what, line: ch.line, right, shown: checkOnly ? undefined : formatQuantity(value), message: right ? 'Right' : checkOnly ? 'Not right yet' : `Not right: it’s ${formatQuantity(value)}` }
  })
}
