import type { CalEvent, Note, TransferStatus } from '../../lib/bridge'
import { occurrences } from '../calendar/recur'
import { dueItems, noteTitle } from '../notes/model'
import { deckOf, deckStats } from '../study/cards'
import { studiedTitle } from '../study/model'

/**
 * The morning brief, evening nudges and "while you were away", worked out from what BridgeDeck
 * already keeps (calendar, checklists, flashcards, transfers), so they work without Mimir.
 */
export type BriefInput = { now: number; events: CalEvent[]; notes: Note[]; courses: string[]; projects: string[]; /** Canvas items (assignments, quizzes) not done yet. */ canvas?: Array<{ title: string; course: string; due: number | null; kind: string }> }

export type Brief = {
  today: Array<{ title: string; start: number; end: number; allDay: boolean }>
  due: Array<{ text: string; note: string; due: number; overdue: boolean }>
  /** Due tomorrow (checklists and Canvas), for the evening nudge. */
  tomorrow: Array<{ text: string; note: string; due: number }>
  soon: Array<{ title: string; start: number; days: number; kind: 'exam' | 'milestone' }>
  cards: Array<{ course: string; due: number }>
}

const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
const addDays = (t: number, n: number) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime() }
const daysBetween = (a: number, b: number) => Math.round((dayStart(b) - dayStart(a)) / 86_400_000)

export function buildBrief({ now, events, notes, courses, projects, canvas = [] }: BriefInput): Brief {
  const today0 = dayStart(now)
  const tomorrow0 = addDays(today0, 1)
  const live = events.filter(e => !e.deleted)
  const isStudyLog = (title: string) => courses.some(c => title === studiedTitle(c))
  const today = live.flatMap(e => occurrences(e, today0, tomorrow0).map(o => ({ title: e.title, allDay: e.allDay, ...o })))
    .filter(e => !isStudyLog(e.title)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
  const fromCanvas = canvas.filter(a => a.due != null && a.kind !== 'event').map(a => ({ text: a.title, note: a.course || 'Canvas', due: a.due! }))
  const checklists = dueItems(notes).map(({ note, block }) => ({ text: block.text, note: noteTitle(note), due: block.due ?? 0 }))
  const all = [...checklists, ...fromCanvas].sort((a, b) => a.due - b.due)
  const due = all.filter(d => d.due < tomorrow0 && now - d.due < 14 * 86_400_000).map(d => ({ ...d, overdue: d.due < now }))
  const tomorrow = all.filter(d => d.due >= tomorrow0 && d.due < addDays(tomorrow0, 1))
  const lower = (s: string) => s.toLowerCase()
  const soon = live.flatMap(e => occurrences(e, tomorrow0, addDays(today0, 8)).map(o => ({ e, start: o.start })))
    .flatMap(({ e, start }) => {
      if (isStudyLog(e.title)) return []
      const kind = courses.some(c => lower(e.title).includes(lower(c))) ? 'exam' as const : projects.some(p => lower(e.title).includes(lower(p))) ? 'milestone' as const : null
      return kind ? [{ title: e.title, start, days: daysBetween(now, start), kind }] : []
    }).sort((a, b) => a.start - b.start)
  const cards = courses.map(course => ({ course, due: (s => s.due + Math.min(s.fresh, 20))(deckStats(deckOf(notes, course), now)) })).filter(c => c.due > 0)
  return { today, due, soon, cards, tomorrow }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const inDays = (days: number) => days <= 1 ? 'tomorrow' : `in ${days} days`

/** One line for a notification: "3 events, 2 tasks due, Math 221: Midterm tomorrow, 14 cards to review". */
export function briefLine(brief: Brief) {
  const parts: string[] = []
  if (brief.today.length) parts.push(plural(brief.today.length, 'event'))
  const overdue = brief.due.filter(d => d.overdue).length
  if (brief.due.length) parts.push(`${plural(brief.due.length, 'task')} due${overdue ? ` (${overdue} overdue)` : ''}`)
  if (brief.soon[0]) parts.push(`${brief.soon[0].title} ${inDays(brief.soon[0].days)}`)
  const cards = brief.cards.reduce((n, c) => n + c.due, 0)
  if (cards) parts.push(`${plural(cards, 'card')} to review`)
  return parts.length ? parts.join(', ') : 'A clear day: nothing scheduled or due.'
}

/** The evening nudge: exams in the next 3 days and flashcards waiting; null when there's nothing. */
export function eveningNudge(brief: Brief): string | null {
  const exams = brief.soon.filter(s => s.kind === 'exam' && s.days <= 3)
  const cards = brief.cards.reduce((n, c) => n + c.due, 0)
  if (!exams.length && !cards && !brief.tomorrow.length) return null
  const parts = exams.map(e => `${e.title} ${inDays(e.days)}`)
  if (brief.tomorrow.length) parts.push(`Due tomorrow: ${brief.tomorrow.slice(0, 3).map(d => d.text.replace(/\s*\(~[\d.]+h\)/, '')).join(', ')}${brief.tomorrow.length > 3 ? ` and ${brief.tomorrow.length - 3} more` : ''}`)
  if (cards) parts.push(`${plural(cards, 'flashcard')} to review (${brief.cards.map(c => `${c.course} ${c.due}`).join(', ')})`)
  return parts.join('. ')
}

/** "HH:MM" today, as a time. */
export function timeToday(hhmm: string, now: number) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(now)
  d.setHours(Number.isFinite(h) ? h : 8, Number.isFinite(m) ? m : 0, 0, 0)
  return d.getTime()
}

/** Whether a once-a-day notice at `hhmm` is due now (not yet given today, and not more than 3 hours late). */
export function dailyDue(hhmm: string, now: number, lastGiven: string) {
  const at = timeToday(hhmm, now)
  const today = new Date(now).toDateString()
  return lastGiven !== today && now >= at && now - at < 3 * 3_600_000
}

export type Away = { since: number; notes: Array<{ id: string; title: string; changes: number }>; events: Array<{ title: string; start: number }>; files: Array<{ names: string[]; from: string }> }

/** What happened on the other computers since `since`: notes and events they changed, files that came in. */
export function whileAway(since: number, me: string, notes: Note[], events: CalEvent[], transfers: TransferStatus[]): Away {
  const fromOthers = (by: string, updated: number) => updated > since && !!by && by !== me
  return {
    since,
    notes: notes.filter(n => !n.deleted).map(n => ({ id: n.id, title: noteTitle(n), changes: n.blocks.filter(b => fromOthers(b.by, b.updated)).length })).filter(n => n.changes > 0).sort((a, b) => b.changes - a.changes),
    events: events.filter(e => !e.deleted && fromOthers(e.by, e.updated)).map(e => ({ title: e.title, start: e.start })),
    files: transfers.filter(t => t.direction === 'receive' && t.state === 'done' && (t.finishedAt ?? 0) > since).map(t => ({ names: t.names, from: t.peerName })),
  }
}

export const awayIsEmpty = (a: Away) => !a.notes.length && !a.events.length && !a.files.length
