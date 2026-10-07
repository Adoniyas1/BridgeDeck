/** Class times: each course's weekly meetings (kept in its `.course.json`) and the semester's dates
 *  and breaks (`.term.json`), so classes show in the calendar and on Home, and class days ("M 1",
 *  "W 2") can be dated without asking. */

import { addDays, startOfDay } from '../calendar/model'

/** Days are 1 = Monday … 7 = Sunday; times "HH:MM". */
export type Meeting = { days: number[]; start: string; end: string; room: string; kind: string }
export type Term = { start: string; end: string; breaks: Array<{ start: string; end: string; name: string }> }
export type ClassTime = { course: string; title: string; kind: string; room: string; start: number; end: number }

export const DAY_LETTERS = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su']
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** The meetings saved for a course, ignoring anything malformed. */
export function meetingsOf(info: { meetings?: unknown }): Meeting[] {
  if (!Array.isArray(info.meetings)) return []
  return info.meetings.flatMap((m): Meeting[] => {
    const days = Array.isArray(m?.days) ? [...new Set((m.days as unknown[]).filter((d): d is number => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7))].sort() : []
    if (!days.length || !TIME.test(m?.start ?? '') || !TIME.test(m?.end ?? '')) return []
    return [{ days, start: m.start, end: m.end, room: String(m.room ?? '').slice(0, 60), kind: String(m.kind ?? '').slice(0, 30) }]
  })
}

/** "MW 10:00–11:15 · ECS 302". */
export function meetingText(m: Meeting) {
  return `${m.days.map(d => DAY_LETTERS[d - 1]).join('')} ${m.start}–${m.end}${m.room ? ` · ${m.room}` : ''}`
}

const dateOf = (text: string) => { const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null }

export function readTerm(text: string): Term | null {
  try {
    const raw = JSON.parse(text) as Partial<Term>
    if (!raw || dateOf(raw.start ?? '') == null || dateOf(raw.end ?? '') == null) return null
    const breaks = Array.isArray(raw.breaks) ? raw.breaks.filter(b => dateOf(b?.start ?? '') != null && dateOf(b?.end ?? '') != null).map(b => ({ start: b.start, end: b.end, name: String(b.name ?? '').slice(0, 40) })) : []
    return { start: raw.start!, end: raw.end!, breaks }
  } catch { return null }
}

/** Whether there are classes on a day: inside the semester (when it's set) and not in a break. */
export function classDay(day: number, term: Term | null) {
  if (!term) return true
  const [start, end] = [dateOf(term.start)!, dateOf(term.end)!]
  if (day < start || day > end) return false
  return !term.breaks.some(b => day >= dateOf(b.start)! && day <= dateOf(b.end)!)
}

const at = (day: number, time: string) => { const [h, m] = time.split(':').map(Number); const d = new Date(day); d.setHours(h, m, 0, 0); return d.getTime() }
const weekday = (day: number) => ((new Date(day).getDay() + 6) % 7) + 1

/** Every class between two times, soonest first. */
export function classesBetween(courses: Array<{ name: string; info: { title?: string; meetings?: unknown } }>, term: Term | null, from: number, to: number): ClassTime[] {
  const out: ClassTime[] = []
  const meetings = courses.map(c => ({ c, list: meetingsOf(c.info) })).filter(x => x.list.length)
  if (!meetings.length) return out
  for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
    if (!classDay(day, term)) continue
    const wd = weekday(day)
    for (const { c, list } of meetings) for (const m of list) {
      if (!m.days.includes(wd)) continue
      const [start, end] = [at(day, m.start), at(day, m.end)]
      if (end > from && start < to) out.push({ course: c.name, title: c.info.title ?? '', kind: m.kind, room: m.room, start, end })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The class on now or next (within a week). */
export function nextClass(courses: Parameters<typeof classesBetween>[0], term: Term | null, now: number) {
  return classesBetween(courses, term, now, addDays(now, 8)).find(c => c.end > now) ?? null
}

/** The Monday of the semester's first week, for dating class days ("M 1", "W 2"). */
export function termFirstMonday(term: Term | null) {
  const start = term ? dateOf(term.start) : null
  if (start == null) return null
  const d = new Date(start)
  return addDays(start, -((d.getDay() + 6) % 7))
}

/** A course's class days in the semester, in order (for "next class" due dates). */
export function classDaysOf(info: { meetings?: unknown }, term: Term | null) {
  const days = new Set(meetingsOf(info).flatMap(m => m.days))
  const [start, end] = term ? [dateOf(term.start)!, dateOf(term.end)!] : [null, null]
  if (!days.size || start == null || end == null) return []
  const out: number[] = []
  for (let day = start; day <= end; day = addDays(day, 1)) if (days.has(weekday(day)) && classDay(day, term)) out.push(day)
  return out
}
