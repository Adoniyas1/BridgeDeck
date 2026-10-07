/** A course's grade, worked out like the syllabus does it: categories with weights (homework 20%,
 *  exams 60%, final 20%), each with its scores. Ungraded items (no score yet) are left out of the
 *  current grade, and "what do I need" solves for an ungraded item's score. Kept in the course's
 *  `.course.json` as `grading`. */

export type GradeItem = { id: string; name: string; got: number | null; max: number }
export type GradeCategory = { id: string; name: string; weight: number; items: GradeItem[] }
export type Grading = { categories: GradeCategory[] }

/** Letter grades with no plus or minus (CSULB's scale), lowest percent for each. */
export const LETTERS: Array<[string, number]> = [['A', 90], ['B', 80], ['C', 70], ['D', 60], ['F', 0]]
export const letterFor = (percent: number) => LETTERS.find(([, min]) => percent >= min - 1e-9)?.[0] ?? 'F'

const num = (v: unknown, fallback: number | null) => typeof v === 'number' && Number.isFinite(v) ? v : fallback

export function readGrading(raw: unknown): Grading {
  const categories = Array.isArray((raw as Grading | undefined)?.categories) ? (raw as Grading).categories : []
  return {
    categories: categories.filter(c => c && typeof c.name === 'string').slice(0, 20).map(c => ({
      id: String(c.id || Math.random().toString(36).slice(2, 8)), name: c.name.slice(0, 40), weight: Math.max(0, num(c.weight, 0)!),
      items: (Array.isArray(c.items) ? c.items : []).filter(i => i && typeof i.name === 'string').slice(0, 100).map(i => ({
        id: String(i.id || Math.random().toString(36).slice(2, 8)), name: i.name.slice(0, 60), got: num(i.got, null), max: Math.max(0, num(i.max, 100)!),
      })),
    })),
  }
}

/** A category's percent from its graded items (by points), or null with none graded. */
export function categoryPercent(c: GradeCategory): number | null {
  const graded = c.items.filter(i => i.got != null && i.max > 0)
  const max = graded.reduce((s, i) => s + i.max, 0)
  return max > 0 ? (graded.reduce((s, i) => s + (i.got ?? 0), 0) / max) * 100 : null
}

/** The current grade: graded categories weighted, scaled to the weight graded so far. */
export function currentPercent(g: Grading): number | null {
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
  const withScore = (x: number): Grading => ({ categories: g.categories.map(c => ({ ...c, items: c.items.map(i => i.id === itemId ? { ...i, got: x } : i) })) })
  const item = g.categories.flatMap(c => c.items).find(i => i.id === itemId)
  if (!item || item.max <= 0) return null
  const [low, high] = [currentPercent(withScore(0)), currentPercent(withScore(item.max))]
  if (low == null || high == null || Math.abs(high - low) < 1e-9) return null
  return ((target - low) / (high - low)) * item.max
}

/** The percent needed on everything not graded yet (each remaining item at that percent of its
 *  points) for the course to reach `target`. Null with nothing left to grade. */
export function neededAverage(g: Grading, target: number): number | null {
  const left = g.categories.some(c => c.weight > 0 && c.items.some(i => i.got == null && i.max > 0))
  if (!left) return null
  const at = (fraction: number): Grading => ({ categories: g.categories.map(c => ({ ...c, items: c.items.map(i => i.got == null ? { ...i, got: i.max * fraction } : i) })) })
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
