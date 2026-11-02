import { evaluate, formatQuantity, unitName, type Quantity } from '../lib/expr'

/** One worked line in the calculator's history. */
export type CalcEntry = { expr: string; result: string; name?: string; value?: Quantity }

const TRIG = /\b(a?(?:sin|cos|tan))\s*\(/g
const NAME = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)\s*(.+)$/
/** Names that already mean something, so they can't be set. */
const RESERVED = new Set(['pi', 'e', 'j', 'i', 'ans', 'sqrt', 'abs', 'mag', 'angle', 'arg', 're', 'im', 'conj', 'exp', 'ln', 'log', 'db', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sind', 'cosd', 'tand', 'asind', 'acosd', 'atand'])

/** In degrees mode sin(30) means 30°: the trig functions become their degree versions. */
export function inDegrees(expr: string): string {
  return expr.replace(TRIG, (_, fn: string) => `${fn}d(`)
}

/** A result to read: plain numbers in full (scientific when very big or small), anything with a
 *  unit or an imaginary part as the engineering calculator shows it ("4.7 kΩ", "3 + j4 = 5 ∠ 53.13°"). */
export function show(v: Quantity): string {
  const real = Math.abs(v.im) < 1e-12 * Math.max(1, Math.abs(v.re))
  if (real && !unitName(v.dim)) {
    const x = v.re
    if (!Number.isFinite(x)) return String(x)
    if (x === 0) return '0'
    const abs = Math.abs(x)
    if (abs >= 1e12 || abs < 1e-6) return x.toExponential(8).replace(/\.?0+e/, 'e').replace('e+', 'e')
    return String(Number(x.toPrecision(12)))
  }
  return formatQuantity(v, 6)
}

// In full, so the value read back is the same number.
const num = (x: number) => String(x)

/** A value as text the calculator reads back (clicking an answer in the history puts this in the
 *  line): "0.005454545454545455 A", "(3+4j)", "(3-4j)*1V"; null when its unit has no name to write. */
export function literal(v: Quantity): string | null {
  const unit = unitName(v.dim)
  if (unit && !/^[A-ZΩa-z]+$/.test(unit)) return null
  const real = Math.abs(v.im) < 1e-12 * Math.max(1, Math.abs(v.re))
  if (real) return unit ? `${num(v.re)} ${unit}` : num(v.re)
  const complex = `(${num(v.re)}${v.im < 0 ? '-' : '+'}${num(Math.abs(v.im))}j)`
  return unit ? `${complex}*1${unit}` : complex
}

/** Works out one line: an expression, or "name = expression" to keep a value. `ans` is the last
 *  answer. Throws with the reason when the line can't be worked out. */
export function calculate(line: string, vars: Record<string, Quantity>, degrees: boolean): { value: Quantity; name?: string } {
  const set = line.match(NAME)
  const [name, expr] = set ? [set[1], set[2]] : [undefined, line]
  if (name && RESERVED.has(name)) throw new Error(`“${name}” already means something; pick another name`)
  if (!expr.trim()) throw new Error('Nothing to work out')
  const value = evaluate(degrees ? inDegrees(expr) : expr, vars)
  return { value, name }
}

/** What's kept between runs: the history, the names set, and the angle mode. */
export type CalcState = { history: CalcEntry[]; vars: Record<string, Quantity>; degrees: boolean }
const MAX_HISTORY = 50

const isQuantity = (v: unknown): v is Quantity => !!v && typeof v === 'object' && typeof (v as Quantity).re === 'number' && typeof (v as Quantity).im === 'number' && Array.isArray((v as Quantity).dim) && (v as Quantity).dim.length === 4 && (v as Quantity).dim.every(n => typeof n === 'number')

export function readState(raw: string | null): CalcState {
  const empty: CalcState = { history: [], vars: {}, degrees: true }
  try {
    const d = JSON.parse(raw ?? 'null') as Partial<CalcState> | null
    if (!d || typeof d !== 'object') return empty
    const history = Array.isArray(d.history) ? d.history.filter(h => h && typeof h.expr === 'string' && typeof h.result === 'string').map(h => (h.value && !isQuantity(h.value) ? { ...h, value: undefined } : h)).slice(-MAX_HISTORY) : []
    const vars: Record<string, Quantity> = {}
    for (const [k, v] of Object.entries(d.vars ?? {})) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && isQuantity(v)) vars[k] = v
    }
    return { history, vars, degrees: d.degrees !== false }
  } catch { return empty }
}

/** The state after a line is worked out: added to the history, kept as `ans` (and its name). */
export function remember(state: CalcState, expr: string, value: Quantity, name?: string): CalcState {
  const entry: CalcEntry = { expr: expr.trim(), result: show(value), value, ...(name ? { name } : {}) }
  return { ...state, history: [...state.history, entry].slice(-MAX_HISTORY), vars: { ...state.vars, ans: value, ...(name ? { [name]: value } : {}) } }
}
