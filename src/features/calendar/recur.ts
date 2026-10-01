import type { CalEvent } from '../../lib/bridge'
import { DAY, daysInMonth } from './model'

/** Occurrence starts of an event, in order, from its first (repeating events go on forever unless
 *  the rule ends them; the caller stops). Times keep the same local clock time across DST. */
function* candidates(event: CalEvent, skipAhead: number): Generator<number> {
  const base = new Date(event.start)
  const r = event.repeat!
  const interval = Math.max(1, r.interval || 1)
  const at = (y: number, m: number, d: number) => new Date(y, m, d, base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds()).getTime()
  const [y, m, d] = [base.getFullYear(), base.getMonth(), base.getDate()]
  if (r.freq === 'daily') {
    for (let i = skipAhead; ; i++) yield at(y, m, d + i * interval)
  } else if (r.freq === 'weekly') {
    const days = r.days.length ? [...r.days].sort((a, b) => a - b) : [base.getDay()]
    for (let w = skipAhead; ; w++) for (const day of days) yield at(y, m, d - base.getDay() + w * 7 * interval + day)
  } else if (r.freq === 'monthly') {
    for (let i = 0; ; i++) {
      const month = new Date(y, m + i * interval, 1)
      if (daysInMonth(month.getFullYear(), month.getMonth()) >= d) yield at(month.getFullYear(), month.getMonth(), d)
    }
  } else {
    for (let i = 0; ; i++) {
      const year = y + i * interval
      if (daysInMonth(year, m) >= d) yield at(year, m, d)
    }
  }
}

/** The event's occurrences that overlap [from, to). */
export function occurrences(event: CalEvent, from: number, to: number): Array<{ start: number; end: number }> {
  const length = Math.max(0, event.end - event.start)
  const overlaps = (start: number) => start < to && (length ? start + length > from : start >= from)
  if (!event.repeat) return overlaps(event.start) ? [{ start: event.start, end: event.end }] : []
  const r = event.repeat
  const skip = new Set(event.skip)
  const until = r.until ?? Infinity
  const limit = r.count ?? Infinity
  // Without a count, jump close to `from` rather than walking years of daily repeats.
  let skipAhead = 0
  if (r.count == null && (r.freq === 'daily' || r.freq === 'weekly')) {
    const period = (r.freq === 'daily' ? DAY : 7 * DAY) * Math.max(1, r.interval || 1)
    skipAhead = Math.max(0, Math.floor((from - length - event.start) / period) - 1)
  }
  const out: Array<{ start: number; end: number }> = []
  let n = 0
  let guard = 0
  for (const start of candidates(event, skipAhead)) {
    if (++guard > 50_000) break
    if (start < event.start) continue
    if (start > until || n >= limit || start >= to) break
    n++
    if (!skip.has(start) && overlaps(start)) out.push({ start, end: start + length })
  }
  return out
}

/** A short description of how an event repeats. */
export function describeRepeat(event: CalEvent) {
  const r = event.repeat
  if (!r) return ''
  const every = r.interval > 1 ? `Every ${r.interval} ` : 'Every '
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq] ?? r.freq
  let text = r.interval > 1 ? `${every}${unit}s` : `${every}${unit}`
  if (r.freq === 'weekly' && r.days.length) {
    const weekdays = [1, 2, 3, 4, 5]
    text = r.days.length === 5 && weekdays.every(d => r.days.includes(d)) && r.interval <= 1 ? 'Every weekday'
      : `${text} on ${r.days.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}`
  }
  if (r.count) text += `, ${r.count} times`
  else if (r.until) text += `, until ${new Date(r.until).toLocaleDateString()}`
  return text
}
