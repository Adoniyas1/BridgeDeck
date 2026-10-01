import type { CalEvent } from '../../lib/bridge'

export const DAY = 86_400_000

/** What the calendar shows: an event occurrence, a checklist item due from Notes, or an Apple
 *  Calendar event or Reminder from the Mac. */
export type Item = {
  key: string
  source: 'event' | 'todo' | 'apple'
  title: string
  start: number
  end: number
  allDay: boolean
  color: string
  event?: CalEvent
  noteId?: string
  calendar?: string
  checked?: boolean
}

export const COLORS: Array<[string, string]> = [
  ['blue', '#6ea8fe'], ['green', '#4fc98a'], ['red', '#f07178'], ['orange', '#f5a454'],
  ['purple', '#b48efa'], ['teal', '#4cc9c0'], ['gray', '#9aa0aa'],
]

export function colorOf(name: string) {
  return COLORS.find(([n]) => n === name)?.[1] ?? COLORS[0][1]
}

export function startOfDay(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function addDays(ms: number, days: number) {
  const d = new Date(ms)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export function addMonths(ms: number, months: number) {
  const d = new Date(ms)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())))
  return d.getTime()
}

export function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

export function startOfWeek(ms: number, weekStart: number) {
  const d = new Date(startOfDay(ms))
  d.setDate(d.getDate() - ((d.getDay() - weekStart + 7) % 7))
  return d.getTime()
}

/** The 6 weeks shown for the month containing `ms`. */
export function monthGrid(ms: number, weekStart: number) {
  const first = new Date(ms)
  first.setDate(1)
  const start = startOfWeek(first.getTime(), weekStart)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

export function sameDay(a: number, b: number) {
  return startOfDay(a) === startOfDay(b)
}

/** The item touches this day (all-day items end at the next midnight, exclusive). */
export function touchesDay(item: Item, day: number) {
  const next = addDays(day, 1)
  if (item.end <= item.start) return item.start >= day && item.start < next
  return item.start < next && item.end > day
}

/** Lays out timed items of one day side by side where they overlap: each gets a column and the
 *  number of columns in its group. */
export function layoutDay(items: Item[]) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  const placed: Array<{ item: Item; column: number; columns: number }> = []
  let group: typeof placed = []
  let groupEnd = -Infinity
  const close = () => { const columns = Math.max(1, ...group.map(g => g.column + 1)); group.forEach(g => { g.columns = columns }) }
  for (const item of sorted) {
    const end = Math.max(item.end, item.start + 15 * 60_000)
    if (item.start >= groupEnd) { close(); group = []; groupEnd = -Infinity }
    const busy = new Set(group.filter(g => Math.max(g.item.end, g.item.start + 15 * 60_000) > item.start).map(g => g.column))
    let column = 0
    while (busy.has(column)) column++
    const entry = { item, column, columns: 1 }
    group.push(entry)
    placed.push(entry)
    groupEnd = Math.max(groupEnd, end)
  }
  close()
  return placed
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function weekdayName(day: number, short = false) {
  return short ? WEEKDAYS[day].slice(0, 3) : WEEKDAYS[day]
}

export function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function formatRange(item: Pick<Item, 'start' | 'end' | 'allDay'>) {
  if (item.allDay) {
    const days = Math.round((item.end - item.start) / DAY)
    return days > 1 ? `All day · ${days} days` : 'All day'
  }
  if (item.end <= item.start) return formatTime(item.start)
  return `${formatTime(item.start)} – ${formatTime(item.end)}`
}

/** "2026-10-01" in local time, for date inputs. */
export function dateInput(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function timeInput(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromInputs(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number)
  const [h, min] = (time || '00:00').split(':').map(Number)
  return new Date(y, (m || 1) - 1, d || 1, h || 0, min || 0).getTime()
}
