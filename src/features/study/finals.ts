/** Finals from the CSULB final exam schedule (pasted from its web page each term): the table goes
 *  by when a class meets ("MW 9:30", "TuTh 2:00 PM") and gives the final's day and time. Each
 *  course's lecture is matched to its row. */

import { readDays } from './timetable'
import type { Meeting } from './schedule'

export type FinalRow = { days: number[]; start: number; date: { month: number; day: number }; from: number; to: number }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "9:30", "9:30 AM", "2 PM" → minutes; a time without AM/PM from 7 to 11 is morning, else afternoon. */
function time(text: string, ampm?: string): number | null {
  const m = text.match(/^(\d{1,2})(?::(\d{2}))?$/)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (h > 23 || min > 59) return null
  const pm = ampm ? /p/i.test(ampm) : h >= 1 && h <= 6
  if (h < 12 && pm) h += 12
  if (h === 12 && ampm && /a/i.test(ampm)) h = 0
  return h * 60 + min
}

/** Rows of the pasted schedule: the class's days and start, then the final's date and times. */
export function readFinals(text: string): FinalRow[] {
  const out: FinalRow[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    const cls = line.match(/\b((?:M|Tu|W|Th|F|Sa|T|R)+)\b[ ,|-]*(\d{1,2}(?::\d{2})?)\s*(AM|PM|a\.m\.|p\.m\.)?/i)
    const date = line.match(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.? (\\d{1,2})\\b`, 'i'))
    const span = [...line.matchAll(/(\d{1,2}(?::\d{2})?)\s*(AM|PM|a\.m\.|p\.m\.)?\s*[-–]\s*(\d{1,2}(?::\d{2})?)\s*(AM|PM|a\.m\.|p\.m\.)?/gi)].at(-1)
    if (!cls || !date || !span) continue
    const days = readDays(cls[1])
    const start = time(cls[2], cls[3])
    const to = time(span[3], span[4])
    const from = time(span[1], span[2] ?? span[4])
    if (!days || start == null || from == null || to == null || from >= to) continue
    out.push({ days, start, date: { month: MONTHS.indexOf(date[1].slice(0, 3).toLowerCase()), day: Number(date[2]) }, from, to })
  }
  return out
}

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
const same = (a: number[], b: number[]) => a.length === b.length && a.every((d, i) => d === b[i])

/** A course's final from its lecture meeting: the row with the same days and start time (or, when
 *  none matches exactly, the same days and the nearest start within half an hour). */
export function finalFor(meetings: Meeting[], rows: FinalRow[], year: number): { start: number; end: number } | null {
  const lecture = meetings.find(m => !m.kind || /lec/i.test(m.kind)) ?? meetings[0]
  if (!lecture) return null
  const start = minutes(lecture.start)
  const sameDays = rows.filter(r => same(r.days, lecture.days))
  const row = sameDays.find(r => r.start === start) ?? sameDays.filter(r => Math.abs(r.start - start) <= 30).sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0]
  if (!row) return null
  const day = new Date(year, row.date.month, row.date.day)
  return { start: day.getTime() + row.from * 60_000, end: day.getTime() + row.to * 60_000 }
}
