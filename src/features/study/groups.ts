/** Study groups and lab partners: when everyone is free. Your own class times come from your
 *  courses; a partner's are typed in their contact's "hours" ("MW 10:00-11:15, TuTh 2-3:15pm"). */

import { readDays, readTimes } from './timetable'

export type Busy = { days: number[]; start: number; end: number }
export type Slot = { day: number; start: number; end: number }

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))

/** "MW 10:00-11:15, TuTh 2-3:15pm; F 9-12" → busy times (minutes from midnight). Times without
 *  am/pm are read as 24-hour. Pieces that don't read are skipped. */
export function parseBusy(text: string): Busy[] {
  return text.split(/[,;\n]+/).flatMap(piece => {
    const m = piece.trim().match(/^([A-Za-z]+)\s+(.+)$/)
    const days = m ? readDays(m[1]) : null
    if (!m || !days) return []
    const raw = m[2].replace(/\s+/g, '')
    const ampm = readTimes(raw)
    if (ampm) return [{ days, start: minutes(ampm[0]), end: minutes(ampm[1]) }]
    const t = raw.match(/^(\d{1,2})(?::(\d{2}))?[-–](\d{1,2})(?::(\d{2}))?$/)
    if (!t) return []
    const [start, end] = [Number(t[1]) * 60 + Number(t[2] ?? 0), Number(t[3]) * 60 + Number(t[4] ?? 0)]
    return start < end && end <= 24 * 60 ? [{ days, start, end }] : []
  })
}

/** The times everyone is free, Monday to Friday between `from` and `to` (minutes), at least
 *  `min` minutes long. */
export function freeSlots(busy: Busy[], from = 8 * 60, to = 20 * 60, min = 60): Slot[] {
  const out: Slot[] = []
  for (let day = 1; day <= 5; day++) {
    const taken = busy.filter(b => b.days.includes(day)).map(b => [Math.max(from, b.start), Math.min(to, b.end)]).filter(([s, e]) => s < e).sort((a, b) => a[0] - b[0])
    let at = from
    for (const [s, e] of taken) {
      if (s - at >= min) out.push({ day, start: at, end: s })
      at = Math.max(at, e)
    }
    if (to - at >= min) out.push({ day, start: at, end: to })
  }
  return out
}

export const clockText = (m: number) => { const h = Math.floor(m / 60), mm = m % 60; return `${(h + 11) % 12 + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}` }
