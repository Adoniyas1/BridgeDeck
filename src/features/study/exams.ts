import type { CalEvent } from '../../lib/bridge'
import { occurrences } from '../calendar/recur'
import { belongsTo, type Assignment } from './canvas'

/** An exam, from the calendar (added in Study or by hand) or from Canvas. */
export type Exam = { id: string; course: string; title: string; start: number; end: number; room: string; allowed: string; covers: string; source: 'calendar' | 'canvas'; eventId?: string }

type CourseLike = { name: string; info: { code?: string; canvasCode?: string } }

export const EXAM_WORDS = /\b(exam|midterm|mid-term|final|test)\b/i

/** The "Allowed:" and "Covers:" lines kept in an exam event's notes. */
export function examNotes(notes: string) {
  const line = (key: string) => notes.match(new RegExp(`^${key}:\\s*(.+)$`, 'im'))?.[1].trim() ?? ''
  return { allowed: line('Allowed'), covers: line('Covers') }
}
export const examNotesText = (allowed: string, covers: string) => [allowed.trim() && `Allowed: ${allowed.trim()}`, covers.trim() && `Covers: ${covers.trim()}`].filter(Boolean).join('\n')

/** Every exam from now on (and today's), soonest first: calendar events of a course that say exam,
 *  midterm, final or test (or are red, as Study makes them), and Canvas items that do. One exam list
 *  for the planner, Home, reminders and the exam-day card. */
export function examsFrom(events: CalEvent[], canvas: Assignment[], courses: CourseLike[], now = Date.now()): Exam[] {
  const from = now - 12 * 3_600_000, to = now + 180 * 86_400_000
  const courseOf = (text: string) => courses.find(c => [c.name, c.info.code ?? ''].some(n => n && text.toLowerCase().includes(n.toLowerCase())))?.name ?? ''
  const out: Exam[] = []
  for (const e of events) {
    if (e.deleted || e.title.startsWith('Study:') || e.title.startsWith('Studied ')) continue
    const course = courseOf(e.title)
    if (!course || !(EXAM_WORDS.test(e.title) || e.color === 'red')) continue
    const { allowed, covers } = examNotes(e.notes)
    for (const o of occurrences(e, from, to)) out.push({ id: `cal:${e.id}:${o.start}`, eventId: e.id, course, title: e.title.replace(new RegExp(`^${course.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`, 'i'), ''), start: o.start, end: o.end, room: e.location, allowed, covers, source: 'calendar' })
  }
  for (const a of canvas) {
    if (a.due == null || a.due < from || a.due > to || !EXAM_WORDS.test(a.title)) continue
    const course = courses.find(c => belongsTo({ name: c.name, code: c.info.code, canvasCode: c.info.canvasCode }, a.course))?.name ?? a.course
    // The same exam already on the calendar (same course, within a day) isn't listed twice.
    if (out.some(x => x.course === course && Math.abs(x.start - a.due!) < 86_400_000)) continue
    out.push({ id: a.id, course, title: a.title, start: a.due, end: a.due + 2 * 3_600_000, room: '', allowed: '', covers: '', source: 'canvas' })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** What to bring to an exam, from what's allowed. */
export function bringList(allowed: string) {
  const list = ['Student ID', 'Pencils and an eraser', 'A pen']
  if (/calculator/i.test(allowed)) list.push('Calculator (fresh battery)')
  if (/sheet|note card|notecard|formula/i.test(allowed)) list.push('Formula sheet')
  if (/scantron/i.test(allowed)) list.push('Scantron')
  if (/blue ?book/i.test(allowed)) list.push('Blue book')
  list.push('Water', 'A watch (phones away)')
  return list
}

/** When to leave for an exam: the trip there, plus 15 minutes to park and find the room. */
export const leaveBy = (exam: Exam, commuteMinutes: number) => exam.start - (commuteMinutes + 15) * 60_000

/** Exam-day notices due now: the evening before (9:30 pm) and leave-by time. Keys say which. */
export function examNoticesDue(exams: Exam[], now: number, commuteMinutes: number, given: Set<string>) {
  const out: Array<{ key: string; exam: Exam; kind: 'evening' | 'leave' }> = []
  for (const exam of exams) {
    const evening = new Date(exam.start); evening.setDate(evening.getDate() - 1); evening.setHours(21, 30, 0, 0)
    const leave = leaveBy(exam, commuteMinutes)
    for (const [kind, at] of [['evening', evening.getTime()], ['leave', leave]] as const) {
      const key = `${exam.id}:${kind}`
      if (!given.has(key) && now >= at && now - at < 60 * 60_000 && now < exam.start) out.push({ key, exam, kind })
    }
  }
  return out
}
