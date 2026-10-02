import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs'
import type { Note, NoteBlock } from '../../lib/bridge'
import { courseFolder } from './model'

/**
 * Flashcards are lines in a course's "… flashcards" note: `front :: back`, the same format the
 * Obsidian spaced-repetition plugins read. Review state rides along in an HTML comment
 * (`<!--fsrs due=… -->`), hidden in Notes and Obsidian's preview, so the schedule syncs with the note.
 */
export type FlashCard = { noteId: string; block: NoteBlock; front: string; back: string; card: Card }

const scheduler = fsrs({ enable_fuzz: true })
const STATE = /\s*<!--fsrs ([^>]*?)-->/

export const flashcardsTitle = (course: string) => `${course} — flashcards`
export const isCardNote = (note: Note) => note.title.toLowerCase().includes('flashcards')

export function parseCard(text: string): { front: string; back: string; card: Card } | null {
  const body = text.replace(/<!--[\s\S]*?-->/g, '')
  const split = body.indexOf(' :: ')
  if (split < 0) return null
  const front = body.slice(0, split).trim()
  const back = body.slice(split + 4).trim()
  if (!front || !back) return null
  return { front, back, card: decodeState(text.match(STATE)?.[1] ?? '') }
}

function decodeState(raw: string): Card {
  const v = Object.fromEntries(raw.split(/\s+/).filter(Boolean).map(kv => kv.split('=') as [string, string]))
  const num = (k: string, d = 0) => Number.isFinite(Number(v[k])) && v[k] !== undefined ? Number(v[k]) : d
  if (!v.due) return createEmptyCard(new Date(0))
  return {
    due: new Date(num('due')), stability: num('s'), difficulty: num('d'), elapsed_days: 0, scheduled_days: num('sd'),
    learning_steps: num('ls'), reps: num('r'), lapses: num('l'), state: num('st') as State,
    last_review: v.lr ? new Date(num('lr')) : undefined,
  }
}

export function encodeState(card: Card) {
  const round = (n: number) => Math.round(n * 1000) / 1000
  const parts = [`due=${card.due.getTime()}`, `s=${round(card.stability)}`, `d=${round(card.difficulty)}`, `sd=${card.scheduled_days}`, `ls=${card.learning_steps}`, `r=${card.reps}`, `l=${card.lapses}`, `st=${card.state}`]
  if (card.last_review) parts.push(`lr=${card.last_review.getTime()}`)
  return `<!--fsrs ${parts.join(' ')}-->`
}

/** The block's text with the card's new review state. */
export function withState(text: string, card: Card) {
  return `${text.replace(STATE, '').trimEnd()} ${encodeState(card)}`
}

/** A card line for a note (one line; " :: " inside a side would split it wrongly). */
export function cardLine(front: string, back: string, source = '') {
  const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/ :: /g, ' : ').trim()
  return `${clean(front)} :: ${clean(back)}${source ? ` (${source})` : ''}`
}

/** Every card of a course: lines `front :: back` in its flashcard notes. */
export function deckOf(notes: Note[], course: string): FlashCard[] {
  const folder = courseFolder(course).toLowerCase()
  return notes
    .filter(n => !n.deleted && n.folder.toLowerCase() === folder && isCardNote(n))
    .flatMap(n => n.blocks.filter(b => !b.deleted).flatMap(block => {
      const parsed = parseCard(block.text)
      return parsed ? [{ noteId: n.id, block, ...parsed }] : []
    }))
}

/** Cards to review now: those due, oldest due first, then new ones (up to `newLimit`). */
export function dueCards(deck: FlashCard[], now = Date.now(), newLimit = 20) {
  const due = deck.filter(c => c.card.state !== State.New && c.card.due.getTime() <= now).sort((a, b) => a.card.due.getTime() - b.card.due.getTime())
  const fresh = deck.filter(c => c.card.state === State.New).slice(0, newLimit)
  return [...due, ...fresh]
}

export function deckStats(deck: FlashCard[], now = Date.now()) {
  return {
    total: deck.length,
    fresh: deck.filter(c => c.card.state === State.New).length,
    due: deck.filter(c => c.card.state !== State.New && c.card.due.getTime() <= now).length,
    learned: deck.filter(c => c.card.state === State.Review).length,
  }
}

export const GRADES: Array<{ grade: Grade; label: string; key: string }> = [
  { grade: Rating.Again, label: 'Again', key: '1' },
  { grade: Rating.Hard, label: 'Hard', key: '2' },
  { grade: Rating.Good, label: 'Good', key: '3' },
  { grade: Rating.Easy, label: 'Easy', key: '4' },
]

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

export function span(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min}m`
  if (min < 1440) return `${Math.round(min / 60)}h`
  const days = Math.round(min / 1440)
  if (days < 31) return `${days}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}
