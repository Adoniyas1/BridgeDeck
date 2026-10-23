/** Next semester's timetable from sections pasted from the CSULB class schedule
 *  (web.csulb.edu/depts/enrollment/registration/class_schedule): each course's sections with their
 *  days, times and rooms, one picked per course, checked for clashes. */

import type { Meeting } from './schedule'

export type Section = { course: string; title: string; section: string; classNo: string; kind: string; days: number[]; start: string; end: string; room: string; instructor: string }

const DAY_CODES: Array<[string, number]> = [['Su', 7], ['Sa', 6], ['Th', 4], ['Tu', 2], ['M', 1], ['W', 3], ['F', 5], ['R', 4], ['T', 2]]

/** "MW" → [1, 3], "TuTh" → [2, 4]; null when it isn't a day list. */
export function readDays(text: string): number[] | null {
  let rest = text.trim()
  if (!rest || rest.length > 12) return null
  const out: number[] = []
  while (rest) {
    const hit = DAY_CODES.find(([code]) => rest.startsWith(code))
    if (!hit) return null
    out.push(hit[1])
    rest = rest.slice(hit[0].length)
  }
  return [...new Set(out)].sort()
}

/** "11-12:15PM" → ["11:00", "12:15"]; "7:30-8:45AM"; "2-4:45PM" → ["14:00", "16:45"]. The start
 *  takes the end's AM/PM unless that would put it after the end. */
export function readTimes(text: string): [string, string] | null {
  const m = text.replace(/\s+/g, '').match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)?[-–](\d{1,2})(?::(\d{2}))?(AM|PM)$/i)
  if (!m) return null
  const to24 = (h: number, pm: boolean) => (h % 12) + (pm ? 12 : 0)
  const endPm = m[6].toUpperCase() === 'PM'
  const end = to24(Number(m[4]), endPm) * 60 + Number(m[5] ?? 0)
  let start = to24(Number(m[1]), m[3] ? m[3].toUpperCase() === 'PM' : endPm) * 60 + Number(m[2] ?? 0)
  if (!m[3] && start > end) start = to24(Number(m[1]), false) * 60 + Number(m[2] ?? 0)
  const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
  return start < end ? [hhmm(start), hhmm(end)] : null
}

const KINDS = /^(LEC|LAB|SEM|ACT|DIS|SUP|FLD|CLN|LCD)$/i

/** The sections in pasted schedule text. A course heading ("EE 381  PROBABILITY AND STATISTICS")
 *  starts each course; a section line has a section number, the class number, a type, days and a
 *  time ("01  6014  LEC  MW  11-12:15PM  ECS-302  Smith J"). TBA and online sections are skipped. */
export function readSchedule(text: string): Section[] {
  const out: Section[] = []
  let course = '', title = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    const heading = line.match(/^([A-Z]{2,5}) ?(\d{3}[A-Z]?)\b\s*(.*)$/)
    if (heading && !/\d{4,5}/.test(heading[3].split(' ')[0] ?? '')) { course = `${heading[1]} ${heading[2]}`; title = heading[3].replace(/\(\d.*$/, '').trim(); continue }
    if (!course) continue
    const words = line.split(' ')
    const timeAt = words.findIndex(w => readTimes(w))
    if (timeAt < 1) continue
    const days = readDays(words[timeAt - 1])
    if (!days) continue
    const [start, end] = readTimes(words[timeAt])!
    const section = words.find(w => /^\d{2}$/.test(w)) ?? ''
    const classNo = words.find(w => /^\d{4,5}$/.test(w)) ?? ''
    const kind = words.find(w => KINDS.test(w))?.toUpperCase() ?? ''
    const after = words.slice(timeAt + 1).filter(w => !/^\d+$/.test(w))
    const room = after[0] && /^[A-Z]{2,5}[- ]?\d/.test(after[0]) ? after[0] : ''
    const instructor = after.slice(room ? 1 : 0).join(' ')
    out.push({ course, title, section, classNo, kind, days, start, end, room, instructor })
  }
  return out
}

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
/** Two sections that meet at the same time on a shared day. */
export const clash = (a: Section, b: Section) => a.days.some(d => b.days.includes(d)) && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end)

/** The pairs of picked sections that clash. */
export function clashes(picked: Section[]): Array<[Section, Section]> {
  const out: Array<[Section, Section]> = []
  for (let i = 0; i < picked.length; i++) for (let j = i + 1; j < picked.length; j++) if (clash(picked[i], picked[j])) out.push([picked[i], picked[j]])
  return out
}

/** A section as a course's weekly meeting (study/schedule.ts). */
export const meetingOf = (s: Section): Meeting => ({ days: s.days, start: s.start, end: s.end, room: s.room.replace('-', ' '), kind: s.kind === 'LEC' ? '' : s.kind.toLowerCase() })

export const sectionKey = (s: Section) => `${s.course}|${s.section}|${s.kind}`
