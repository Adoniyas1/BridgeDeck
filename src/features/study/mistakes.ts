/** A mistake log from graded work, and the score expected before handing in against the score got
 *  (to learn whether you over- or under-estimate). Both live in study state `mistakes`:
 *  `m:<id>` → {course, assignment, text, at} and `p:<assignment id>` → {course, assignment, predicted, at}. */

export type Mistake = { id: string; course: string; assignment: string; text: string; at: number }
export type Prediction = { assignmentId: string; course: string; assignment: string; predicted: number; at: number }

export function readMistakes(state: Record<string, unknown>): { mistakes: Mistake[]; predictions: Prediction[] } {
  const mistakes: Mistake[] = [], predictions: Prediction[] = []
  for (const [id, v] of Object.entries(state)) {
    const e = v as Record<string, unknown> | null
    if (!e) continue
    if (id.startsWith('m:') && typeof e.text === 'string' && e.text.trim()) mistakes.push({ id, course: String(e.course ?? ''), assignment: String(e.assignment ?? ''), text: e.text.trim().slice(0, 500), at: Number(e.at) || 0 })
    else if (id.startsWith('p:') && typeof e.predicted === 'number' && e.predicted >= 0 && e.predicted <= 150) predictions.push({ assignmentId: id.slice(2), course: String(e.course ?? ''), assignment: String(e.assignment ?? ''), predicted: e.predicted, at: Number(e.at) || 0 })
  }
  return { mistakes: mistakes.sort((a, b) => b.at - a.at), predictions }
}

/** How predictions compare with what was got: the average gap (positive: expected more than got)
 *  over the graded ones. */
export function calibration(predictions: Prediction[], scores: Record<string, number | null>): { count: number; gap: number } | null {
  const pairs = predictions.flatMap(p => scores[p.assignmentId] != null ? [p.predicted - scores[p.assignmentId]!] : [])
  return pairs.length ? { count: pairs.length, gap: pairs.reduce((s, g) => s + g, 0) / pairs.length } : null
}
