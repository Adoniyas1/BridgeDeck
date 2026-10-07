import { fsrs, type Card, type Grade } from 'ts-fsrs'
import { GRADES, span } from './cards'

/** The spaced-repetition scheduler (FSRS), only needed while reviewing. */
const scheduler = fsrs({ enable_fuzz: true })

export function review(card: Card, grade: Grade, now = new Date()): Card {
  return scheduler.next(card, now, grade).card
}

/** "10m", "1d", "3mo": when the card comes back after each answer. */
export function intervals(card: Card, now = new Date()): Record<number, string> {
  const preview = scheduler.repeat(card, now)
  const out: Record<number, string> = {}
  for (const { grade } of GRADES) out[grade] = span(preview[grade].card.due.getTime() - now.getTime())
  return out
}
