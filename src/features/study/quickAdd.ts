import { addDays, startOfDay } from '../calendar/model'
import { classesBetween, type Term } from './schedule'

type CourseLike = { name: string; info: { code?: string; title?: string; meetings?: unknown; classChanges?: unknown } }
export type QuickAdd = { course: string; title: string; due: number | null; hours: number | null; dueText: string }

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** The next meeting of a course (of a kind: "lab", "lecture"…, or any) starting after `now`. */
export function nextMeeting(course: CourseLike, term: Term | null, now: number, kind = '') {
  return classesBetween([course], term, now, addDays(now, 60)).find(c => c.start > now && (!kind || c.kind.toLowerCase().includes(kind))) ?? null
}

function at(day: number, h: number, m: number) {
  const d = new Date(day)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

/** "5pm", "5:30 pm", "17:00" as hours and minutes. */
function timeOf(text: string): [number, number] | null {
  const m = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i)
  if (!m) return null
  if (m[3]) {
    let h = Number(m[1]) % 12
    if (m[3].toLowerCase() === 'pm') h += 12
    return [h, Number(m[2] ?? 0)]
  }
  return [Number(m[4]), Number(m[5])]
}

/** Reads "EE 310 HW 5 due next class ~3h", "lab report due next lab", "quiz 4 due fri 5pm",
 *  "essay due 10/31": the course (a course's name or code at the start), what it is, when it's due,
 *  and the hours it'll take. */
export function parseQuickAdd(text: string, courses: CourseLike[], term: Term | null, now = Date.now(), fallbackCourse = ''): QuickAdd {
  let rest = ` ${text.trim()} `
  // The course: the longest name or code it starts with.
  const names = courses.flatMap(c => [c.name, c.info.code ?? ''].filter(Boolean).map(n => ({ c, n })))
    .sort((a, b) => b.n.length - a.n.length)
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  let course = courses.find(c => c.name === fallbackCourse) ?? null
  for (const { c, n } of names) {
    const head = rest.trimStart()
    const m = head.match(new RegExp(`^${n.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')}\\b[:,-]?`, 'i'))
    if (m && norm(m[0]).startsWith(norm(n))) { course = c; rest = ` ${head.slice(m[0].length)} `; break }
  }
  // Hours: "~3h", "3 hours", "(2.5h)".
  let hours: number | null = null
  rest = rest.replace(/\(?~?\s*(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\b\)?/i, (_, h: string) => { hours = Number(h); return ' ' })
  // When: everything from "due" (or a bare "by") on.
  let due: number | null = null
  let dueText = ''
  const when = rest.match(/\s(?:due|by)\s+(.+?)\s*$/i)
  if (when) {
    const w = when[1].toLowerCase()
    const time = timeOf(w)
    const kind = w.match(/\bnext\s+(class|lab|lecture|discussion|section)\b/)
    const today = startOfDay(now)
    let day: number | null = null
    if (kind && course) {
      const meeting = nextMeeting(course, term, now, kind[1] === 'class' ? '' : kind[1] === 'section' ? 'discussion' : kind[1])
      if (meeting) { due = time ? at(meeting.start, ...time) : meeting.start; dueText = `next ${kind[1]}` }
    } else if (/\btoday|tonight\b/.test(w)) day = today
    else if (/\btomorrow\b/.test(w)) day = addDays(today, 1)
    else if (/\bnext week\b/.test(w)) day = addDays(today, 7)
    else {
      const named = DAYS.findIndex(d => new RegExp(`\\b${d.slice(0, 3)}(${d.slice(3)})?\\b`).test(w))
      const slash = w.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
      const month = w.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/)
      if (named >= 0) {
        const ahead = (named - new Date(today).getDay() + 7) % 7 || 7
        day = addDays(today, ahead)
      } else if (slash || month) {
        const [mo, d] = slash ? [Number(slash[1]) - 1, Number(slash[2])] : [MONTHS.indexOf(month![1]), Number(month![2])]
        const year = slash?.[3] ? (Number(slash[3]) < 100 ? 2000 + Number(slash[3]) : Number(slash[3])) : new Date(now).getFullYear()
        let date = new Date(year, mo, d).getTime()
        if (!slash?.[3] && date < today) date = new Date(year + 1, mo, d).getTime()
        day = date
      }
    }
    if (day != null) { due = at(day, ...(time ?? [23, 59])); dueText = when[1].trim() }
    if (due != null) rest = rest.slice(0, when.index)
  }
  const title = rest.replace(/\s+/g, ' ').trim().replace(/^[:,-]\s*/, '')
  return { course: course?.name ?? fallbackCourse, title: hours ? `${title} (~${hours}h)` : title, due, hours, dueText }
}
