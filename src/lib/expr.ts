/** An engineering calculator's arithmetic: complex numbers with SI units, read from text like
 *
 *    R1 = 4.7k
 *    C = 10uF
 *    Z = R1 || 1/(j 2pi 1kHz C)
 *    5∠53° + 3-2j
 *    12V / 2.2kΩ
 *
 *  Numbers take SI prefixes (p n u µ m k M G T) and units (Ω ohm V A F H s Hz W J C S), "j" or "i" for
 *  the imaginary part, "a∠b°" for a phasor, and "||" for things in parallel. Nothing here runs code:
 *  the text is read into a tree and worked out. */

/** Powers of the base units [m, kg, s, A]. */
type Dim = [number, number, number, number]
export type Quantity = { re: number; im: number; dim: Dim }

const NONE: Dim = [0, 0, 0, 0]
const UNITS: Record<string, Dim> = {
  V: [2, 1, -3, -1], A: [0, 0, 0, 1], Ω: [2, 1, -3, -2], F: [-2, -1, 4, 2], H: [2, 1, -2, -2],
  s: [0, 0, 1, 0], Hz: [0, 0, -1, 0], W: [2, 1, -3, 0], J: [2, 1, -2, 0], C: [0, 0, 1, 1], S: [-2, -1, 3, 2],
}
const ALIASES: Record<string, string> = { ohm: 'Ω', ohms: 'Ω', Ohm: 'Ω', R: 'Ω', volt: 'V', volts: 'V', amp: 'A', amps: 'A', sec: 's', hz: 'Hz', mho: 'S' }
const PREFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }
/** Units to show a result in, in order of preference. */
const SHOW = ['Ω', 'V', 'A', 'F', 'H', 'W', 'Hz', 's', 'J', 'C', 'S']

/** Own keys only, so "constructor" or "toString" aren't names. */
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const q = (re: number, im = 0, dim: Dim = NONE): Quantity => ({ re, im, dim })
const sameDim = (a: Dim, b: Dim) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9)
const addDim = (a: Dim, b: Dim, k = 1): Dim => a.map((v, i) => v + k * b[i]) as Dim
const scaleDim = (a: Dim, k: number): Dim => a.map(v => v * k) as Dim

function add(a: Quantity, b: Quantity, sign = 1): Quantity {
  // A plain number can be added to anything when it's zero; otherwise units must match.
  if (!sameDim(a.dim, b.dim) && !(b.re === 0 && b.im === 0) && !(a.re === 0 && a.im === 0)) throw new Error(`Can’t add ${unitName(a.dim)} and ${unitName(b.dim)}`)
  const dim = a.re === 0 && a.im === 0 ? b.dim : a.dim
  return q(a.re + sign * b.re, a.im + sign * b.im, dim)
}
const mul = (a: Quantity, b: Quantity) => q(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re, addDim(a.dim, b.dim))
function div(a: Quantity, b: Quantity) {
  const d = b.re * b.re + b.im * b.im
  if (d === 0) throw new Error('Division by zero')
  return q((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d, addDim(a.dim, b.dim, -1))
}
function pow(a: Quantity, b: Quantity) {
  if (b.im !== 0 || !sameDim(b.dim, NONE)) throw new Error('A power must be a plain real number')
  const r = Math.hypot(a.re, a.im), t = Math.atan2(a.im, a.re), k = b.re
  if (r === 0) return q(0, 0, scaleDim(a.dim, k))
  const m = Math.pow(r, k)
  // Whole powers of real numbers stay real (no tiny imaginary parts).
  if (a.im === 0 && Number.isInteger(k)) return q(Math.pow(a.re, k), 0, scaleDim(a.dim, k))
  return q(m * Math.cos(k * t), m * Math.sin(k * t), scaleDim(a.dim, k))
}
const parallel = (a: Quantity, b: Quantity) => div(mul(a, b), add(a, b))

const plain = (a: Quantity, name: string) => { if (!sameDim(a.dim, NONE)) throw new Error(`${name} needs a plain number`); return a }
const cexp = (a: Quantity) => { const m = Math.exp(a.re); return q(m * Math.cos(a.im), m * Math.sin(a.im)) }
const FUNCTIONS: Record<string, (a: Quantity) => Quantity> = {
  sqrt: a => pow(a, q(0.5)),
  abs: a => q(Math.hypot(a.re, a.im), 0, a.dim), mag: a => q(Math.hypot(a.re, a.im), 0, a.dim),
  angle: a => q(Math.atan2(a.im, a.re) * 180 / Math.PI), arg: a => q(Math.atan2(a.im, a.re) * 180 / Math.PI),
  re: a => q(a.re, 0, a.dim), im: a => q(a.im, 0, a.dim), conj: a => q(a.re, -a.im, a.dim),
  exp: a => cexp(plain(a, 'exp')),
  ln: a => { plain(a, 'ln'); return q(Math.log(Math.hypot(a.re, a.im)), Math.atan2(a.im, a.re)) },
  log: a => { plain(a, 'log'); return q(Math.log10(Math.hypot(a.re, a.im))) },
  db: a => q(20 * Math.log10(Math.hypot(a.re, a.im))),
  sin: a => q(Math.sin(plain(a, 'sin').re)), cos: a => q(Math.cos(plain(a, 'cos').re)), tan: a => q(Math.tan(plain(a, 'tan').re)),
  asin: a => q(Math.asin(plain(a, 'asin').re)), acos: a => q(Math.acos(plain(a, 'acos').re)), atan: a => q(Math.atan(plain(a, 'atan').re)),
}
const CONSTANTS: Record<string, Quantity> = { pi: q(Math.PI), π: q(Math.PI), e: q(Math.E), j: q(0, 1), i: q(0, 1) }

type Token = { k: 'num'; v: Quantity } | { k: 'name'; v: string } | { k: 'op'; v: string }

/** A unit word after a number: "kΩ", "mA", "uF", "Hz", "k" alone. Returns the scale and dimension. */
function readUnit(word: string): { scale: number; dim: Dim } | null {
  const w = ALIASES[word] ?? word
  if (UNITS[w]) return { scale: 1, dim: UNITS[w] }
  if (w.length > 1 && PREFIX[w[0]] !== undefined) {
    const rest = ALIASES[w.slice(1)] ?? w.slice(1)
    if (UNITS[rest]) return { scale: PREFIX[w[0]], dim: UNITS[rest] }
  }
  if (w.length === 1 && PREFIX[w] !== undefined) return { scale: PREFIX[w], dim: NONE }
  return null
}

function tokenize(text: string, vars: Record<string, Quantity> = {}): Token[] {
  const src = text.replace(/·|×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\*\*/g, '^')
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    const num = src.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i)
    if (num) {
      let value = Number(num[0]), dim = NONE
      i += num[0].length
      // "2k2" (2.2k), then a unit or prefix right after, or after one space when it's a unit word.
      const mid = src.slice(i).match(/^([kKMmuµμnpGT])(\d+)(?![a-zA-Z])/)
      if (mid) { value = Number(`${num[0]}.${mid[2]}`) * PREFIX[mid[1]]; i += mid[0].length }
      {
        // A unit after a space ("4.7k ohm") unless it's a name set earlier ("2 C" with C = 10uF).
        const readWord = (prefixOk: boolean) => {
          const word = src.slice(i).match(/^\s?([a-zA-ZΩµμ]+)/)
          const unit = word ? readUnit(word[1]) : null
          if (!word || !unit) return false
          const spaced = word[0].startsWith(' ')
          if (unit.dim === NONE && (spaced || !prefixOk)) return false
          if (spaced && has(vars, word[1])) return false
          value *= unit.scale; dim = unit.dim; i += word[0].length
          return true
        }
        if (mid) readWord(false)
        else if (readWord(true) && dim === NONE) readWord(false)
      }
      // A degree mark after a number turns it into radians for ∠ (handled by the parser).
      out.push({ k: 'num', v: q(value, 0, dim) })
      continue
    }
    if (src.startsWith('||', i)) { out.push({ k: 'op', v: '||' }); i += 2; continue }
    if (c === '∠' || (c === '<' && src[i + 1] !== '=')) { out.push({ k: 'op', v: '∠' }); i++; continue }
    if (c === '°') {
      out.push({ k: 'op', v: '°' }); i++
      // "10∠-30° V": the unit after the angle belongs to the whole phasor.
      const word = src.slice(i).match(/^\s?([a-zA-ZΩµμ]+)/)
      const unit = word && !has(vars, word[1]) ? readUnit(word[1]) : null
      if (word && unit && unit.dim !== NONE) { out.push({ k: 'num', v: q(unit.scale, 0, unit.dim) }); i += word[0].length }
      continue
    }
    const name = src.slice(i).match(/^[a-zA-ZπΩµμ_][a-zA-Z0-9_Ωµμ]*/)
    if (name) { out.push({ k: 'name', v: name[0] }); i += name[0].length; continue }
    if ('+-*/^()='.includes(c)) { out.push({ k: 'op', v: c }); i++; continue }
    throw new Error(`Can’t read “${c}”`)
  }
  return out
}

/** Works out one expression, with `vars` for names set earlier. */
export function evaluate(text: string, vars: Record<string, Quantity> = {}): Quantity {
  const tokens = tokenize(text, vars)
  let i = 0
  const peek = () => tokens[i]
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v
  const take = (v: string) => { if (!isOp(v)) throw new Error(`Expected “${v}”`); i++ }

  // parallel  := sum ('||' sum)*
  // sum       := product (('+'|'-') product)*
  // product   := unary (('*'|'/') unary | implied)*
  // unary     := '-' unary | power
  // power     := phasor ('^' unary)?
  // phasor    := atom ('∠' atom '°'?)?
  function parallelExpr(): Quantity {
    let a = sum()
    while (isOp('||')) { i++; a = parallel(a, sum()) }
    return a
  }
  function sum(): Quantity {
    let a = product()
    while (isOp('+') || isOp('-')) { const op = tokens[i++].v; a = add(a, product(), op === '+' ? 1 : -1) }
    return a
  }
  function startsAtom() { const t = peek(); return !!t && (t.k === 'num' || t.k === 'name' || (t.k === 'op' && t.v === '(')) }
  function product(): Quantity {
    let a = unary()
    for (;;) {
      if (isOp('*')) { i++; a = mul(a, unary()) }
      else if (isOp('/')) { i++; a = div(a, unary()) }
      else if (startsAtom()) a = mul(a, power())
      else return a
    }
  }
  function unary(): Quantity {
    if (isOp('-')) { i++; const a = unary(); return q(-a.re, -a.im, a.dim) }
    if (isOp('+')) { i++; return unary() }
    return power()
  }
  function power(): Quantity {
    const a = phasor()
    if (isOp('^')) { i++; return pow(a, unary()) }
    return a
  }
  function phasor(): Quantity {
    const m = atom()
    if (!isOp('∠')) return m
    i++
    // The angle is in degrees, with or without the ° mark.
    let deg: number
    const sign = isOp('-') ? (i++, -1) : 1
    const t0 = peek()
    if (t0?.k === 'num') { i++; deg = sign * plain(t0.v, 'An angle').re; if (isOp('°')) i++ }
    else deg = sign * plain(atom(), 'An angle').re
    const t = deg * Math.PI / 180
    return q(m.re * Math.cos(t) - m.im * Math.sin(t), m.re * Math.sin(t) + m.im * Math.cos(t), m.dim)
  }
  function atom(): Quantity {
    const t = peek()
    if (!t) throw new Error('Something’s missing at the end')
    if (t.k === 'num') { i++; return isOp('°') ? (i++, q(t.v.re * Math.PI / 180)) : t.v }
    if (t.k === 'op' && t.v === '(') { i++; const a = parallelExpr(); take(')'); return a }
    if (t.k === 'name') {
      i++
      if (has(vars, t.v)) return vars[t.v]
      const fn = FUNCTIONS[t.v.toLowerCase()]
      if (fn && isOp('(')) { i++; const a = parallelExpr(); take(')'); return fn(a) }
      if (has(CONSTANTS, t.v)) return CONSTANTS[t.v]
      // A unit on its own: "5j V", "(1+2j) kΩ".
      const unit = readUnit(t.v)
      if (unit && unit.dim !== NONE) return q(unit.scale, 0, unit.dim)
      throw new Error(`Unknown name “${t.v}”`)
    }
    throw new Error(`Unexpected “${t.v}”`)
  }
  const value = parallelExpr()
  if (i < tokens.length) throw new Error(`Unexpected “${tokens[i].k === 'num' ? 'number' : tokens[i].v}”`)
  return value
}

// ---- Showing results ----

/** The unit for a dimension: a named one, or base units. */
export function unitName(dim: Dim): string {
  if (sameDim(dim, NONE)) return ''
  const named = SHOW.find(u => sameDim(UNITS[u], dim))
  if (named) return named
  const base = ['m', 'kg', 's', 'A']
  return dim.map((p, k) => p === 0 ? '' : p === 1 ? base[k] : `${base[k]}^${Number(p.toFixed(3))}`).filter(Boolean).join('·')
}

const ENG: Array<[number, string]> = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']]

/** A real number in engineering notation, with a prefix when it has a unit: "4.7 k", "220 µ". */
export function engineering(value: number, unit: string, digits = 4): string {
  if (!Number.isFinite(value)) return String(value)
  if (value === 0) return `0${unit ? ` ${unit}` : ''}`
  const abs = Math.abs(value)
  if (!unit && abs >= 1e-4 && abs < 1e7) return `${Number(value.toPrecision(digits))}`
  const [scale, prefix] = ENG.find(([s]) => abs >= s * 0.9995) ?? ENG[ENG.length - 1]
  const shown = Number((value / scale).toPrecision(digits))
  return unit ? `${shown} ${prefix}${unit}` : prefix ? `${shown}${prefix}` : `${shown}`
}

/** A result as text: real, or complex as rectangular and polar. */
export function formatQuantity(v: Quantity, digits = 4): string {
  const unit = unitName(v.dim)
  const tiny = (x: number, ref: number) => Math.abs(x) < 1e-12 * Math.max(1, Math.abs(ref))
  if (tiny(v.im, v.re)) return engineering(v.re, unit, digits)
  const mag = Math.hypot(v.re, v.im), deg = Math.atan2(v.im, v.re) * 180 / Math.PI
  const rect = tiny(v.re, v.im) ? `j${engineering(v.im, '', digits)}` : `${engineering(v.re, '', digits)} ${v.im < 0 ? '−' : '+'} j${engineering(Math.abs(v.im), '', digits)}`
  return `${rect}${unit ? ` ${unit}` : ''} = ${engineering(mag, unit, digits)} ∠ ${Number(deg.toFixed(2))}°`
}

/** Lines of a calculator block worked out in order: "name = expression" sets a name for the lines
 *  after it. Each line gets its result or what's wrong with it; blank lines and "# notes" are skipped. */
export function runLines(text: string): Array<{ line: string; result?: string; error?: string; name?: string; step?: 'ok' | 'wrong' }> {
  const vars: Record<string, Quantity> = {}
  // The expression the next "= …" line is checked against.
  let previous: string | null = null
  return text.split('\n').map(raw => {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) return { line: raw }
    const bands = resistorFromBands(line)
    if (bands) return { line: raw, result: bands }
    if (line.startsWith('=') && !line.startsWith('==')) {
      const expr = line.slice(1).trim()
      if (previous === null) return { line: raw, error: 'Nothing above to compare this step with' }
      try {
        const check = sameExpression(previous, expr, vars)
        previous = expr
        return check.same ? { line: raw, result: '✓ same as the line above', step: 'ok' } : { line: raw, error: `✗ not equal to the line above: ${check.example}`, step: 'wrong' }
      } catch (e) { return { line: raw, error: e instanceof Error ? e.message : String(e) } }
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.+)$/)
    try {
      if (m && !has(FUNCTIONS, m[1].toLowerCase())) {
        if (has(CONSTANTS, m[1])) throw new Error(`“${m[1]}” is a constant`)
        const free = freeNames(m[2], vars)
        if (free.length) { previous = m[2]; return { line: raw, name: m[1], result: `in terms of ${free.join(', ')}` } }
        const value = evaluate(m[2], vars)
        vars[m[1]] = value
        previous = m[2]
        return { line: raw, name: m[1], result: formatQuantity(value) }
      }
      previous = line
      const free = freeNames(line, vars)
      if (free.length) return { line: raw, result: `in terms of ${free.join(', ')}` }
      return { line: raw, result: formatQuantity(evaluate(line, vars)) }
    } catch (e) { return { line: raw, error: e instanceof Error ? e.message : String(e) } }
  })
}

/** Evaluates with any unknown names given values from `pick` (and returns which were unknown). */
function evaluateWith(text: string, vars: Record<string, Quantity>, pick: (name: string) => number): { value: Quantity; free: string[] } {
  const own = { ...vars }
  const free: string[] = []
  for (let tries = 0; tries < 12; tries++) {
    try { return { value: evaluate(text, own), free } } catch (e) {
      const name = e instanceof Error ? e.message.match(/^Unknown name “(.+)”$/)?.[1] : undefined
      if (!name || has(own, name)) throw e
      free.push(name)
      own[name] = q(pick(name))
    }
  }
  throw new Error('Too many unknown names')
}

/** Names in the expression that aren't set (letters to solve with). */
export function freeNames(text: string, vars: Record<string, Quantity> = {}): string[] {
  return evaluateWith(text, vars, () => 1.3).free
}

/** Whether two expressions are equal for any values of their letters, tried at a few values (as a
 *  step check: not a proof, but a wrong step almost never passes). */
export function sameExpression(a: string, b: string, vars: Record<string, Quantity> = {}): { same: boolean; example?: string } {
  const seed = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7)
  for (let trial = 0; trial < 4; trial++) {
    const pick = (name: string) => 0.37 + ((seed(name) * (trial + 3) * 7919) % 1000) / 311
    const x = evaluateWith(a, vars, pick), y = evaluateWith(b, vars, pick)
    const size = Math.max(Math.hypot(x.value.re, x.value.im), Math.hypot(y.value.re, y.value.im), 1e-12)
    const off = Math.hypot(x.value.re - y.value.re, x.value.im - y.value.im)
    const unitsDiffer = unitName(x.value.dim) !== unitName(y.value.dim) && !(off === 0)
    if (off / size > 1e-9 || unitsDiffer) {
      const names = [...new Set([...x.free, ...y.free])]
      const at = names.map(n => `${n} = ${Number(pick(n).toPrecision(3))}`).join(', ')
      return { same: false, example: `${at ? `at ${at}, ` : ''}it’s ${formatQuantity(y.value)}, the line above is ${formatQuantity(x.value)}` }
    }
  }
  return { same: true }
}

// ---- Resistor colour bands ----

const COLORS = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'grey', 'white']
const TOLERANCE: Record<string, string> = { brown: '±1%', red: '±2%', green: '±0.5%', blue: '±0.25%', violet: '±0.1%', grey: '±0.05%', gold: '±5%', silver: '±10%' }
const colorIndex = (c: string) => COLORS.indexOf(c === 'gray' ? 'grey' : c === 'purple' ? 'violet' : c)

/** "yellow violet red gold" → "4.7 kΩ ±5%" (4 or 5 bands), or null when the line isn't bands. */
export function resistorFromBands(line: string): string | null {
  const words = line.toLowerCase().replace(/[,;-]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length < 3 || words.length > 6 || !words.every(w => colorIndex(w) >= 0 || w in TOLERANCE)) return null
  const five = words.length >= 5
  const digits = words.slice(0, five ? 3 : 2).map(colorIndex)
  const multiplierWord = words[five ? 3 : 2]
  const mult = multiplierWord === 'gold' ? -1 : multiplierWord === 'silver' ? -2 : colorIndex(multiplierWord)
  if (digits.some(d => d < 0) || mult < -2) return null
  const value = Number(digits.join('')) * Math.pow(10, mult)
  const tol = TOLERANCE[words[five ? 4 : 3]] ?? (words.length === 3 ? '±20%' : '')
  return `${engineering(value, 'Ω', 3)}${tol ? ` ${tol}` : ''}`
}

/** The bands for a resistor value (4 bands): 4700 → "yellow violet red". */
export function bandsFor(ohms: number): string | null {
  if (!(ohms >= 0.1) || ohms >= 1e11) return null
  const exp = Math.floor(Math.log10(ohms)) - 1
  const digits = Math.round(ohms / Math.pow(10, exp))
  if (digits >= 100) return bandsFor(Math.round(ohms / Math.pow(10, exp + 1)) * Math.pow(10, exp + 1))
  const mult = exp === -1 ? 'gold' : exp === -2 ? 'silver' : COLORS[exp]
  return `${COLORS[Math.floor(digits / 10)]} ${COLORS[digits % 10]} ${mult}`
}
