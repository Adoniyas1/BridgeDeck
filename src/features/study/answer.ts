/** Typed answers for number cards: a back side with `{{num:4.7k ohm ±2%}}` asks for a number, and
 *  what's typed is worked out (units, prefixes, complex numbers; see lib/expr.ts) and compared. */

import { evaluate, formatQuantity, unitName, type Quantity } from '../../lib/expr'

const SPEC = /\{\{num:([^}]*)\}\}/
/** Within 1% when the card doesn't say. */
const DEFAULT_TOLERANCE = 0.01

export type AnswerSpec = { value: Quantity; tolerance: number; text: string }

/** The number a card wants, or null for an ordinary card (or one whose number can't be read). */
export function answerSpec(back: string): AnswerSpec | null {
  const m = back.match(SPEC)
  if (!m) return null
  const tol = m[1].match(/±\s*([\d.]+)\s*%|\+-\s*([\d.]+)\s*%/)
  const expr = m[1].replace(/(±|\+-)\s*[\d.]+\s*%/, '').trim()
  try {
    return { value: evaluate(expr), tolerance: tol ? Number(tol[1] ?? tol[2]) / 100 : DEFAULT_TOLERANCE, text: expr }
  } catch { return null }
}

/** The back side as shown: the number in place of its {{num:…}}. */
export const showAnswer = (back: string) => back.replace(/\{\{num:([^}]*)\}\}/g, (_, spec: string) => {
  const parsed = answerSpec(`{{num:${spec}}}`)
  return parsed ? formatQuantity(parsed.value) : spec
})

export type Checked = { right: boolean; message: string; grade: 1 | 3 }

/** Whether a typed answer matches: same unit, and within the tolerance. Units may be left off when
 *  the number alone is right ("4.7k" for 4.7 kΩ). */
export function checkAnswer(spec: AnswerSpec, typed: string): Checked {
  let got: Quantity
  try { got = evaluate(typed) } catch (e) { return { right: false, message: e instanceof Error ? e.message : 'Can’t read that', grade: 1 } }
  const wantUnit = unitName(spec.value.dim), gotUnit = unitName(got.dim)
  if (gotUnit && gotUnit !== wantUnit) return { right: false, message: `That’s in ${gotUnit}; the answer is in ${wantUnit || 'no unit'}`, grade: 1 }
  const size = Math.hypot(spec.value.re, spec.value.im)
  const off = Math.hypot(got.re - spec.value.re, got.im - spec.value.im)
  const right = size === 0 ? off < 1e-12 : off / size <= spec.tolerance + 1e-12
  const shown = formatQuantity({ ...got, dim: spec.value.dim })
  return right
    ? { right, message: `Right: ${shown}`, grade: 3 }
    : { right, message: `${shown} is off by ${size ? `${Math.round((off / size) * 1000) / 10}%` : off}; the answer is ${formatQuantity(spec.value)}`, grade: 1 }
}
