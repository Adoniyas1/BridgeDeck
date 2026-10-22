/** A course's grade, worked out like the syllabus does it: categories with weights (homework 20%,
 *  exams 60%, final 20%), each with its scores. Ungraded items (no score yet) are left out of the
 *  current grade, and "what do I need" solves for an ungraded item's score. Kept in the course's
 *  `.course.json` as `grading`. */

/** `extra`: extra credit (its points add to the category without adding to what it's out of).
 *  `canvasId`: the Canvas assignment its score comes from. */
export type GradeItem = { id: string; name: string; got: number | null; max: number; extra?: boolean; canvasId?: string }
/** `drop`: how many of the lowest scores the syllabus drops. */
export type GradeCategory = { id: string; name: string; weight: number; items: GradeItem[]; drop?: number }
/** `mode`: 'weights' (each category its % of the grade) or 'points' (all points added up).
 *  `goal`: the percent aimed for (a warning comes when the grade falls below it). */
export type Grading = { categories: GradeCategory[]; mode?: 'weights' | 'points'; goal?: number }

/** Letter grades with no plus or minus (CSULB's scale), lowest percent for each. */
export const LETTERS: Array<[string, number]> = [['A', 90], ['B', 80], ['C', 70], ['D', 60], ['F', 0]]
export const letterFor = (percent: number) => LETTERS.find(([, min]) => percent >= min - 1e-9)?.[0] ?? 'F'

const num = (v: unknown, fallback: number | null) => typeof v === 'number' && Number.isFinite(v) ? v : fallback

export function readGrading(raw: unknown): Grading {
  const r = raw as Grading | undefined
  const categories = Array.isArray(r?.categories) ? r!.categories : []
  return {
    categories: categories.filter(c => c && typeof c.name === 'string').slice(0, 20).map(c => ({
      id: String(c.id || Math.random().toString(36).slice(2, 8)), name: c.name.slice(0, 40), weight: Math.max(0, num(c.weight, 0)!),
      ...(num(c.drop, 0)! > 0 ? { drop: Math.min(20, Math.floor(num(c.drop, 0)!)) } : {}),
      items: (Array.isArray(c.items) ? c.items : []).filter(i => i && typeof i.name === 'string').slice(0, 100).map(i => ({
        id: String(i.id || Math.random().toString(36).slice(2, 8)), name: i.name.slice(0, 60), got: num(i.got, null), max: Math.max(0, num(i.max, 100)!),
        ...(i.extra === true ? { extra: true } : {}), ...(typeof i.canvasId === 'string' && i.canvasId ? { canvasId: i.canvasId.slice(0, 40) } : {}),
      })),
    })),
    ...(r?.mode === 'points' ? { mode: 'points' as const } : {}),
    ...(num(r?.goal, 0)! > 0 ? { goal: Math.min(100, num(r?.goal, 0)!) } : {}),
  }
}

/** The graded items that count: extra credit aside, the `drop` lowest (by percent) are left out
 *  while more than that are graded. */
function counted(c: GradeCategory) {
  const graded = c.items.filter(i => i.got != null && (i.max > 0 || i.extra))
  const regular = graded.filter(i => !i.extra && i.max > 0).sort((a, b) => (b.got! / b.max) - (a.got! / a.max))
  const kept = c.drop && regular.length > c.drop ? regular.slice(0, regular.length - c.drop) : regular
  return { kept, extra: graded.filter(i => i.extra) }
}

/** A category's points: what's been got and what it was out of (extra credit adds only to got). */
function categoryPoints(c: GradeCategory) {
  const { kept, extra } = counted(c)
  return { got: [...kept, ...extra].reduce((s, i) => s + (i.got ?? 0), 0), max: kept.reduce((s, i) => s + i.max, 0) }
}

/** A category's percent from its graded items (by points), or null with none graded. */
export function categoryPercent(c: GradeCategory): number | null {
  const { got, max } = categoryPoints(c)
  return max > 0 ? (got / max) * 100 : null
}

/** The current grade: graded categories weighted (or, in points mode, all points added up), scaled
 *  to what's graded so far. */
export function currentPercent(g: Grading): number | null {
  if (g.mode === 'points') {
    const points = g.categories.map(categoryPoints)
    const max = points.reduce((s, p) => s + p.max, 0)
    return max > 0 ? (points.reduce((s, p) => s + p.got, 0) / max) * 100 : null
  }
  let weight = 0, sum = 0
  for (const c of g.categories) {
    const p = categoryPercent(c)
    if (p == null || c.weight <= 0) continue
    weight += c.weight; sum += p * c.weight
  }
  return weight > 0 ? sum / weight : null
}

/** The score an ungraded item needs for the course to reach `target` percent, counting what's
 *  graded plus that item (the grade is a straight line in its score). Null when the item has no
 *  effect; it may be above the item's points (out of reach) or below zero (already safe). */
export function neededOn(g: Grading, itemId: string, target: number): number | null {
  const withScore = (x: number): Grading => ({ ...g, categories: g.categories.map(c => ({ ...c, items: c.items.map(i => i.id === itemId ? { ...i, got: x } : i) })) })
  const item = g.categories.flatMap(c => c.items).find(i => i.id === itemId)
  if (!item || item.max <= 0) return null
  const [low, high] = [currentPercent(withScore(0)), currentPercent(withScore(item.max))]
  if (low == null || high == null || Math.abs(high - low) < 1e-9) return null
  return ((target - low) / (high - low)) * item.max
}

/** The percent needed on everything not graded yet (each remaining item at that percent of its
 *  points) for the course to reach `target`. Null with nothing left to grade. */
export function neededAverage(g: Grading, target: number): number | null {
  const left = g.categories.some(c => (c.weight > 0 || g.mode === 'points') && c.items.some(i => i.got == null && i.max > 0 && !i.extra))
  if (!left) return null
  const at = (fraction: number): Grading => ({ ...g, categories: g.categories.map(c => ({ ...c, items: c.items.map(i => i.got == null && !i.extra ? { ...i, got: i.max * fraction } : i) })) })
  const [low, high] = [currentPercent(at(0)), currentPercent(at(1))]
  if (low == null || high == null || Math.abs(high - low) < 1e-9) return null
  return ((target - low) / (high - low)) * 100
}

/** Common syllabus layouts to start from. */
export const TEMPLATES: Array<{ name: string; categories: Array<[string, number]> }> = [
  { name: 'Homework 20 · Midterms 50 · Final 30', categories: [['Homework', 20], ['Midterms', 50], ['Final', 30]] },
  { name: 'Homework 15 · Labs 25 · Exams 35 · Final 25', categories: [['Homework', 15], ['Labs', 25], ['Exams', 35], ['Final', 25]] },
  { name: 'Quizzes 20 · Exams 50 · Final 30', categories: [['Quizzes', 20], ['Exams', 50], ['Final', 30]] },
]

/** Which category a Canvas assignment's score goes in, by its name: homework, quizzes, labs, exams,
 *  final; else the first category. */
export function categoryFor(g: Grading, title: string): GradeCategory | null {
  const t = title.toLowerCase()
  const kinds: Array<[RegExp, RegExp]> = [
    [/\bfinal\b/, /final/], [/\b(midterm|exam|test)\b/, /exam|midterm|test/], [/\bquiz/, /quiz/], [/\b(lab|prelab)\b/, /lab/],
    [/\b(hw|homework|problem set|assignment)\b/, /home|hw|assign|problem/], [/\b(project|report)\b/, /project|report/],
  ]
  for (const [title, name] of kinds) {
    if (!title.test(t)) continue
    const c = g.categories.find(x => name.test(x.name.toLowerCase()))
    if (c) return c
  }
  return g.categories[0] ?? null
}

/** Canvas scores filled into the grade sheet: an item already linked to the Canvas assignment (or
 *  with its name) gets the score; others are added to the category their name suggests. Returns the
 *  new sheet and how many scores came in. */
export function withCanvasScores(g: Grading, scored: Array<{ id: string; title: string; score: number; points: number }>, newId: () => string): { grading: Grading; filled: number } {
  let filled = 0
  let next: Grading = { ...g, categories: g.categories.map(c => ({ ...c, items: [...c.items] })) }
  for (const s of scored) {
    const all = next.categories.flatMap(c => c.items)
    const same = all.find(i => i.canvasId === s.id) ?? all.find(i => !i.canvasId && i.name.trim().toLowerCase() === s.title.trim().toLowerCase())
    if (same) {
      if (same.got === s.score && same.max === s.points && same.canvasId === s.id) continue
      next = { ...next, categories: next.categories.map(c => ({ ...c, items: c.items.map(i => i === same ? { ...i, got: s.score, max: s.points, canvasId: s.id } : i) })) }
      filled++
      continue
    }
    const cat = categoryFor(next, s.title)
    if (!cat) continue
    next = { ...next, categories: next.categories.map(c => c.id === cat.id ? { ...c, items: [...c.items, { id: newId(), name: s.title.slice(0, 60), got: s.score, max: s.points, canvasId: s.id }] } : c) }
    filled++
  }
  return { grading: next, filled }
}
