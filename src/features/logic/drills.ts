/** Practice for digital logic: number bases, two's complement and K-map minimisation, with fresh
 *  questions each time and answers checked (any correct form counts; a K-map answer must also be
 *  as short as the minimal one). */

import { evaluate, minimize, parse, variables } from './model'

export type DrillKind = 'base' | 'twos' | 'kmap'
export type Drill = { kind: DrillKind; question: string; answer: string; /** For K-maps: the function's minterms and variables. */ minterms?: number[]; vars?: string[]; bits?: number }

/** A small seeded random generator (the same seed gives the same questions). */
export function rng(seed: number) {
  let x = seed % 2147483647 || 1
  return (n: number) => { x = (x * 48271) % 2147483647; return x % n }
}

const BASES = [2, 8, 10, 16]
const NAMES: Record<number, string> = { 2: 'binary', 8: 'octal', 10: 'decimal', 16: 'hex' }
const show = (n: number, base: number) => n.toString(base).toUpperCase()

export function makeDrill(kind: DrillKind, rand: (n: number) => number): Drill {
  if (kind === 'base') {
    const from = BASES[rand(4)], to = BASES.filter(b => b !== from)[rand(3)]
    const n = 1 + rand(255)
    return { kind, question: `${show(n, from)} (${NAMES[from]}) in ${NAMES[to]}`, answer: show(n, to) }
  }
  if (kind === 'twos') {
    const bits = 8, n = rand(256) - 128
    const binary = ((n + 256) % 256).toString(2).padStart(bits, '0')
    return rand(2) ? { kind, bits, question: `${n} as ${bits}-bit two's complement`, answer: binary } : { kind, bits, question: `${binary} (${bits}-bit two's complement) in decimal`, answer: String(n) }
  }
  const vars = rand(2) ? ['A', 'B', 'C'] : ['A', 'B', 'C', 'D']
  const size = 1 << vars.length
  const minterms = Array.from({ length: size }, (_, i) => i).filter(() => rand(100) < 45)
  const picked = minterms.length && minterms.length < size ? minterms : [1, 3, size - 1]
  return { kind, vars, minterms: picked, question: `Minimal sum of products for F(${vars.join(',')}) = Σm(${picked.join(', ')})`, answer: minimize(vars, picked) }
}

/** How many literals an SOP has ("A'B + C" → 3). */
export const literals = (sop: string) => (sop.match(/[A-Za-z]/g) ?? []).length

export type Marked = { right: boolean; message: string }

export function checkDrill(d: Drill, typed: string): Marked {
  const t = typed.trim()
  if (!t) return { right: false, message: 'Type an answer' }
  if (d.kind === 'base') {
    const clean = t.replace(/^0[bxo]/i, '').replace(/[\s_]/g, '').toUpperCase()
    return clean === d.answer ? { right: true, message: 'Right' } : { right: false, message: `It’s ${d.answer}` }
  }
  if (d.kind === 'twos') {
    const clean = t.replace(/[\s_]/g, '')
    const right = /^[01]+$/.test(d.answer) ? clean.padStart(d.bits ?? 8, '0') === d.answer && clean.length <= (d.bits ?? 8) : Number(clean) === Number(d.answer)
    return right ? { right: true, message: 'Right' } : { right: false, message: `It’s ${d.answer}` }
  }
  let expr
  try { expr = parse(t) } catch (e) { return { right: false, message: e instanceof Error ? e.message : 'Can’t read that' } }
  const vars = d.vars!
  const stray = variables(expr).filter(v => !vars.includes(v))
  if (stray.length) return { right: false, message: `Only ${vars.join(', ')} are inputs (not ${stray.join(', ')})` }
  for (let m = 0; m < 1 << vars.length; m++) {
    const env = Object.fromEntries(vars.map((v, i) => [v, ((m >> (vars.length - 1 - i)) & 1) as 0 | 1]))
    if (evaluate(expr, env) !== (d.minterms!.includes(m) ? 1 : 0)) return { right: false, message: `Not the same function: it’s wrong for m${m}. A minimal answer is ${d.answer}` }
  }
  return literals(t) <= literals(d.answer) ? { right: true, message: 'Right, and minimal' } : { right: false, message: `The same function, but not minimal: ${d.answer} has ${literals(d.answer)} literals` }
}

/** "Predict, then simulate": the outputs guessed for each row of a circuit's truth table, marked
 *  against what the circuit does. Rows are indexed like the table; a blank guess counts as wrong.
 *  Don't-care outputs (null) aren't marked. */
export function markPrediction(rows: Array<{ out: Array<0 | 1 | null> }>, guesses: Record<string, 0 | 1>) {
  let right = 0, total = 0
  const wrong: Array<{ row: number; out: number }> = []
  rows.forEach((row, r) => row.out.forEach((v, o) => {
    if (v === null) return
    total++
    if (guesses[`${r}:${o}`] === v) right++
    else wrong.push({ row: r, out: o })
  }))
  return { right, total, wrong }
}
