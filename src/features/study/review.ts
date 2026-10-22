import { fsrs, type Card, type FSRS, type Grade } from 'ts-fsrs'
import { configStore } from '../../core/config'
import { GRADES, span } from './cards'

/** The spaced-repetition scheduler (FSRS), only needed while reviewing: tuned to this person's
 *  reviews when they've been fitted (Study → Flashcards → Tune), else the defaults. */
let cached: { key: string; scheduler: FSRS } | null = null
function scheduler() {
  const weights = configStore.get().study.fsrsWeights ?? []
  const key = weights.join(',')
  if (cached?.key !== key) cached = { key, scheduler: fsrs(weights.length >= 19 ? { enable_fuzz: true, w: weights } : { enable_fuzz: true }) }
  return cached.scheduler
}

export function review(card: Card, grade: Grade, now = new Date()): Card {
  return scheduler().next(card, now, grade).card
}

/** "10m", "1d", "3mo": when the card comes back after each answer. */
export function intervals(card: Card, now = new Date()): Record<number, string> {
  const preview = scheduler().repeat(card, now)
  const out: Record<number, string> = {}
  for (const { grade } of GRADES) out[grade] = span(preview[grade].card.due.getTime() - now.getTime())
  return out
}

/** The chance of remembering the card now (0-1). */
export const retrievability = (card: Card, now = new Date()) => scheduler().get_retrievability(card, now, false)
