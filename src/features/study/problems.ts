/** Homework problems from an assignment's text, one by one, to tick off: "Ch 10.1: 3, 7-15 (odd),
 *  18; Ch 10.2: 2, 5" → 10.1 #3, #7, #9 … #15, #18, 10.2 #2, #5. Ticks are kept beside the courses
 *  (`.problems.json`, by assignment). */

export type Problem = { key: string; section: string; number: string }

/** One section's list: "3, 7-15 (odd), 18, 13a, 1a-7a (odd)". */
function expandList(section: string, text: string): Problem[] {
  const out: Problem[] = []
  const add = (number: string) => { const key = `${section ? `${section}#` : '#'}${number}`; if (!out.some(p => p.key === key)) out.push({ key, section, number }) }
  // Brackets other than (odd)/(even) are remarks: "(just use calculator)".
  const clean = text.replace(/\((?!\s*(odd|even)\s*\))[^)]*\)/gi, ' ')
  const range = /(\d+)([a-z]?)\s*[-–]\s*(\d+)([a-z]?)\s*(\(\s*(odd|even)\s*\))?/gi
  let rest = clean
  for (const m of clean.matchAll(range)) {
    const [from, to] = [Number(m[1]), Number(m[3])]
    if (to < from || to - from > 200) continue
    const parity = m[6]?.toLowerCase()
    for (let n = from; n <= to; n++) if (!parity || (parity === 'odd') === (n % 2 === 1)) add(`${n}${m[2] || m[4] || ''}`)
    rest = rest.replace(m[0], ' ')
  }
  for (const m of rest.matchAll(/(?<![\d.])(\d{1,3})([a-z]?)(?![\d.?])/gi)) add(`${m[1]}${m[2]}`)
  const order = (p: Problem) => parseInt(p.number) * 10 + (p.number.match(/[a-z]$/i)?.[0].toLowerCase().charCodeAt(0) ?? 96) - 96
  return out.sort((a, b) => order(a) - order(b))
}

export function expandProblems(text: string): Problem[] {
  // Sections: "Ch 10.1:", "Ch10.2 =", "10.3:", "§4.2".
  const marker = /(?:\bch(?:apter)?\.?\s*|§\s*|\b)(\d{1,2}\.\d{1,2})\s*[:=]/gi
  const marks = [...text.matchAll(marker)]
  if (!marks.length) return /\d/.test(text) && /[,–-]/.test(text) ? expandList('', text.replace(/^[^:]*:/, '')) : []
  return marks.flatMap((m, i) => expandList(m[1], text.slice(m.index! + m[0].length, marks[i + 1]?.index ?? text.length)))
}

export const problemLabel = (p: Problem, many: boolean) => many && p.section ? `${p.section} #${p.number}` : `#${p.number}`

/** A ticked problem's id in the study state: "<assignment>\u001f<problem>" (study_state.rs SEP). */
const SEP = '\u001f'
export const problemId = (assignment: string, problem: string) => `${assignment}${SEP}${problem}`

/** How a problem went: needed help, or got stuck. Hard ones come back before exams. Kept in study
 *  state `ratings` by problemId, with what's needed to show it again without the assignment. */
export type Rating = 'help' | 'stuck'
export type RatedProblem = { id: string; rating: Rating; course: string; assignment: string; section: string; number: string; at: number }

export function ratingsFromState(state: Record<string, unknown>): RatedProblem[] {
  return Object.entries(state).flatMap(([id, v]) => {
    const r = v as Partial<RatedProblem> | null
    if (!r || (r.rating !== 'help' && r.rating !== 'stuck') || typeof r.number !== 'string') return []
    return [{ id, rating: r.rating, course: String(r.course ?? ''), assignment: String(r.assignment ?? ''), section: String(r.section ?? ''), number: r.number, at: Number(r.at) || 0 }]
  }).sort((a, b) => (a.rating === b.rating ? 0 : a.rating === 'stuck' ? -1 : 1) || b.at - a.at)
}

/** The next rating when clicked again: none → help → stuck → none. */
export const nextRating = (r: Rating | undefined): Rating | null => r === undefined ? 'help' : r === 'help' ? 'stuck' : null

/** Ticks by assignment from the merged study state. */
export function problemsFromState(state: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [id, value] of Object.entries(state)) {
    const at = id.indexOf(SEP)
    if (at <= 0 || value !== true) continue
    ;(out[id.slice(0, at)] ??= []).push(id.slice(at + 1))
  }
  return out
}
