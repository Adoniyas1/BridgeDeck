// Types only: the scheduler itself (ts-fsrs) is in review.ts, loaded with the Study tab, so Home's
// counts don't bring it into the start-up bundle.
import type { Card, Grade, State } from 'ts-fsrs'
import type { Note, NoteBlock } from '../../lib/bridge'
import { courseFolder } from './model'

/**
 * Flashcards are lines in a course's "… flashcards" note:
 *
 *    front :: back                      one card
 *    front ::: back                     two cards, one each way (sub-cards "f" and "b")
 *    The {{c1::anode}} is {{c2::positive::sign}}   one card per cN, answer hidden (the hint shows)
 *
 * Review state rides along in an HTML comment, hidden in Notes: `<!--fsrs due=… s=…-->` for a
 * one-card line, and `<!--fsrs f: due=… s=… | b: due=…-->` (one group per sub-card) otherwise.
 * Builds before this one read only `front :: back`, which is written exactly as before. The shared
 * examples in card-vectors.json are checked here and in Rust (mimir_api.rs).
 */
export type FlashCard = { id: string; noteId: string; block: NoteBlock; sub: string; front: string; back: string; card: Card }
export type ParsedCard = { sub: string; front: string; back: string; card: Card }

/** ts-fsrs's State values. */
const NEW = 0 as State, REVIEW = 2 as State
const STATE = /\s*<!--fsrs ([^>]*?)-->/
const CLOZE = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g

/** Tags on a line that aren't part of the card: put aside, or one that keeps being forgotten. */
const MARKS = /\s#(suspended|leech)\b/g
/** Forgotten this many times: a leech, better rewritten than reviewed again. */
export const LEECH_LAPSES = 8

export const flashcardsTitle = (course: string) => `${course} — flashcards`
export const isCardNote = (note: Note) => note.title.toLowerCase().includes('flashcards')

/** The review state of each sub-card ("" for a one-card line). */
function statesOf(text: string): Record<string, string> {
  const raw = text.match(STATE)?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const group of raw.split('|')) {
    const m = group.trim().match(/^([a-z0-9]+):\s*(.*)$/i)
    if (m) out[m[1]] = m[2]
    else if (group.trim()) out[''] = group.trim()
  }
  return out
}

/** The cards in one line: none, one, two (both ways) or one per cloze. */
export function parseCards(text: string): ParsedCard[] {
  const body = text.replace(/<!--[\s\S]*?-->/g, '').replace(MARKS, '')
  const states = statesOf(text)
  const both = body.indexOf(' ::: ')
  if (both >= 0) {
    const front = body.slice(0, both).trim(), back = body.slice(both + 5).trim()
    if (!front || !back) return []
    return [{ sub: 'f', front, back, card: decodeState(states.f ?? '') }, { sub: 'b', front: back, back: front, card: decodeState(states.b ?? '') }]
  }
  const split = body.indexOf(' :: ')
  if (split >= 0) {
    const front = body.slice(0, split).trim(), back = body.slice(split + 4).trim()
    return front && back ? [{ sub: '', front, back, card: decodeState(states[''] ?? '') }] : []
  }
  const numbers = [...new Set([...body.matchAll(CLOZE)].map(m => m[1]))]
  return numbers.map(n => ({
    sub: `c${n}`,
    front: body.replace(CLOZE, (_, k, answer, hint) => k === n ? `[${hint?.trim() || '…'}]` : answer).trim(),
    back: body.replace(CLOZE, (_, k, answer) => k === n ? `[${answer}]` : answer).trim(),
    card: decodeState(states[`c${n}`] ?? ''),
  }))
}

/** A one-card line (`front :: back`), as older code reads it. */
export function parseCard(text: string): { front: string; back: string; card: Card } | null {
  const cards = parseCards(text)
  return cards.length === 1 && cards[0].sub === '' ? cards[0] : null
}

function decodeState(raw: string): Card {
  const v = Object.fromEntries(raw.split(/\s+/).filter(Boolean).map(kv => kv.split('=') as [string, string]))
  const num = (k: string, d = 0) => Number.isFinite(Number(v[k])) && v[k] !== undefined ? Number(v[k]) : d
  // A new card (what ts-fsrs's createEmptyCard makes).
  if (!v.due) return { due: new Date(0), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: NEW, last_review: undefined }
  return {
    due: new Date(num('due')), stability: num('s'), difficulty: num('d'), elapsed_days: 0, scheduled_days: num('sd'),
    learning_steps: num('ls'), reps: num('r'), lapses: num('l'), state: num('st') as State,
    last_review: v.lr ? new Date(num('lr')) : undefined,
  }
}

function stateText(card: Card) {
  const round = (n: number) => Math.round(n * 1000) / 1000
  const parts = [`due=${card.due.getTime()}`, `s=${round(card.stability)}`, `d=${round(card.difficulty)}`, `sd=${card.scheduled_days}`, `ls=${card.learning_steps}`, `r=${card.reps}`, `l=${card.lapses}`, `st=${card.state}`]
  if (card.last_review) parts.push(`lr=${card.last_review.getTime()}`)
  return parts.join(' ')
}

export const encodeState = (card: Card) => `<!--fsrs ${stateText(card)}-->`

/** The line's text with one sub-card's new review state (the others kept). */
export function withState(text: string, card: Card, sub = '') {
  if (!sub) return `${text.replace(STATE, '').trimEnd()} ${encodeState(card)}`
  const states = statesOf(text)
  delete states['']
  states[sub] = stateText(card)
  const groups = Object.keys(states).sort().map(k => `${k}: ${states[k]}`)
  return `${text.replace(STATE, '').trimEnd()} <!--fsrs ${groups.join(' | ')}-->`
}

/** The sentence with {{cN::…}} around `answer` (the next free number), for "Make cloze". */
export function makeCloze(text: string, answer: string): string {
  const at = text.indexOf(answer)
  if (!answer.trim() || at < 0) return text
  const used = [...text.matchAll(CLOZE)].map(m => Number(m[1]))
  const n = (used.length ? Math.max(...used) : 0) + 1
  return `${text.slice(0, at)}{{c${n}::${answer}}}${text.slice(at + answer.length)}`
}

/** A card line for a note (one line; " :: " inside a side would split it wrongly). */
export function cardLine(front: string, back: string, source = '', bothWays = false) {
  const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/ :::? /g, ' : ').trim()
  return `${clean(front)} ${bothWays ? ':::' : '::'} ${clean(back)}${source ? ` (${source})` : ''}`
}

/** A fill-in-the-blank line (one line, no "::" so it stays a cloze card). */
export const clozeLine = (text: string, source = '') => `${text.replace(/\s+/g, ' ').replace(/ :::? /g, ' : ').trim()}${source ? ` (${source})` : ''}`

/** Every card of a course, from the lines of its flashcard notes. */
export function deckOf(notes: Note[], course: string): FlashCard[] {
  const folder = courseFolder(course).toLowerCase()
  return notes
    .filter(n => !n.deleted && n.folder.toLowerCase() === folder && isCardNote(n))
    .flatMap(n => n.blocks.filter(b => !b.deleted).flatMap(block =>
      parseCards(block.text).map(c => ({ id: `${n.id}/${block.id}${c.sub ? `/${c.sub}` : ''}`, noteId: n.id, block, ...c }))))
}

/** A card line without its review state, as it's edited. */
export const cardBody = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim()
/** The line with new words and the same review state. */
export function withBody(text: string, body: string) {
  const state = text.match(STATE)
  return state ? `${body.trim()} ${state[0].trim()}` : body.trim()
}
export const hasMark = (text: string, mark: 'suspended' | 'leech') => new RegExp(`(^|\\s)#${mark}\\b`).test(cardBody(text))
/** Adds or removes #suspended or #leech on a line. */
export function setMark(text: string, mark: 'suspended' | 'leech', on: boolean) {
  const body = cardBody(text).replace(new RegExp(`\\s*#${mark}\\b`, 'g'), '')
  return withBody(text, on ? `${body} #${mark}` : body)
}
export const isLeech = (c: FlashCard) => c.card.lapses >= LEECH_LAPSES || hasMark(c.block.text, 'leech')

/** The book page a card came from: its trailing "([Title, p. 12](book:…#12))". */
export function cardSource(text: string): { label: string; href: string; page: number } | null {
  const m = text.match(/\(\[([^\]]*)\]\((book:[^)]*#(\d+))\)\)\s*$/)
  return m ? { label: m[1], href: m[2], page: Number(m[3]) } : null
}

export type Mastery = { label: string; cards: number; learned: number; recall: number }

/** How well each part of a course is known: cards grouped by the chapter they came from (from the
 *  chapter starts saved for that book), else by book, with the average chance of remembering them
 *  now (`recall`, 0-1; new cards count as 0). */
export function masteryMap(deck: FlashCard[], chapterStarts: (file: string) => Array<{ title: string; page: number }>, retrievability: (c: Card) => number): Mastery[] {
  const groups = new Map<string, { cards: number; learned: number; sum: number; order: number }>()
  for (const c of deck) {
    const source = cardSource(c.back) ?? cardSource(c.front)
    let label = 'Other cards', order = Infinity
    if (source) {
      const file = decodeURIComponent(source.href.slice(5).split('#')[0].split('/').slice(1).join('/'))
      const book = source.label.replace(/,\s*p\.\s*\d+$/, '').split(',')[0].trim() || file
      const chapter = chapterStarts(file).filter(s => s.page <= source.page).sort((a, b) => b.page - a.page)[0]
      label = chapter ? `${book}: ${chapter.title}` : book
      order = chapter ? chapter.page : 0
    }
    const g = groups.get(label) ?? { cards: 0, learned: 0, sum: 0, order }
    g.cards++
    if (c.card.state === REVIEW) g.learned++
    g.sum += c.card.state === NEW ? 0 : retrievability(c.card)
    groups.set(label, g)
  }
  return [...groups.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([label, g]) => ({ label, cards: g.cards, learned: g.learned, recall: g.sum / g.cards }))
}

/** Cards to review now: those due, oldest due first, then new ones (up to `newLimit`). */
export function dueCards(all: FlashCard[], now = Date.now(), newLimit = 20) {
  const deck = all.filter(c => !hasMark(c.block.text, 'suspended'))
  const due = deck.filter(c => c.card.state !== NEW && c.card.due.getTime() <= now).sort((a, b) => a.card.due.getTime() - b.card.due.getTime())
  const fresh = deck.filter(c => c.card.state === NEW).slice(0, newLimit)
  return [...due, ...fresh]
}

/** Due cards from every course, taken in turn (one from each course, then again), so a session
 *  mixes subjects. */
export function allDue(notes: Note[], courses: string[], now = Date.now(), newLimit = 20): FlashCard[] {
  const queues = courses.map(course => dueCards(deckOf(notes, course), now, newLimit))
  const out: FlashCard[] = []
  for (let i = 0; queues.some(q => i < q.length); i++) for (const q of queues) if (i < q.length) out.push(q[i])
  return out
}

export function deckStats(all: FlashCard[], now = Date.now()) {
  const deck = all.filter(c => !hasMark(c.block.text, 'suspended'))
  return {
    total: deck.length,
    fresh: deck.filter(c => c.card.state === NEW).length,
    due: deck.filter(c => c.card.state !== NEW && c.card.due.getTime() <= now).length,
    learned: deck.filter(c => c.card.state === REVIEW).length,
  }
}

/** The answers, with ts-fsrs's Rating values. */
export const GRADES: Array<{ grade: Grade; label: string; key: string }> = [
  { grade: 1 as Grade, label: 'Again', key: '1' },
  { grade: 2 as Grade, label: 'Hard', key: '2' },
  { grade: 3 as Grade, label: 'Good', key: '3' },
  { grade: 4 as Grade, label: 'Easy', key: '4' },
]

export function span(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min}m`
  if (min < 1440) return `${Math.round(min / 60)}h`
  const days = Math.round(min / 1440)
  if (days < 31) return `${days}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}
