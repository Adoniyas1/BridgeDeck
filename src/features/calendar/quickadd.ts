import type { CalRepeat } from '../../lib/bridge'
import { DAY, addDays, startOfDay } from './model'

export type QuickEvent = { title: string; start: number; end: number; allDay: boolean; repeat: CalRepeat | null }

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_WORD = '(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?'
const MONTH_WORD = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'

function dayIndex(word: string) {
  return DAYS.indexOf(word.toLowerCase().slice(0, 3))
}

/** Whether this computer writes dates day-first (31/12) rather than month-first (12/31). */
function dayFirst() {
  try {
    const parts = new Intl.DateTimeFormat().formatToParts(new Date(2020, 11, 31))
    return parts.find(p => p.type === 'day' || p.type === 'month')?.type === 'day'
  } catch { return false }
}

function hour24(hour: number, meridiem?: string) {
  const m = meridiem?.toLowerCase()
  if (m === 'pm' && hour < 12) return hour + 12
  if (m === 'am' && hour === 12) return 0
  return hour
}

/** Reads "Lunch with Sam tomorrow 1pm for 90m", "Dentist Fri 3:30pm", "Standup every weekday
 *  9am", "Mum's birthday Dec 3", "Gym every mon wed fri 7-8am" into an event. */
export function parseQuickAdd(input: string, now = Date.now(), monthFirst = !dayFirst()): QuickEvent {
  let text = ` ${input.trim()} `
  const take = (pattern: RegExp) => {
    const match = text.match(pattern)
    if (match) text = text.replace(match[0], ' ')
    return match
  }

  // How it repeats.
  let repeat: CalRepeat | null = null
  const every = take(new RegExp(`\\bevery\\s+(other\\s+)?(day|weekday|weekend|week|month|year|(?:${DAY_WORD}(?:\\s*(?:,|and|&)?\\s*))+)`, 'i'))
  if (every) {
    const interval = every[1] ? 2 : 1
    const what = every[2].toLowerCase()
    const base = { interval, days: [] as number[], until: null, count: null }
    if (what === 'day') repeat = { freq: 'daily', ...base }
    else if (what === 'weekday') repeat = { freq: 'weekly', ...base, days: [1, 2, 3, 4, 5] }
    else if (what === 'weekend') repeat = { freq: 'weekly', ...base, days: [0, 6] }
    else if (what === 'week') repeat = { freq: 'weekly', ...base }
    else if (what === 'month') repeat = { freq: 'monthly', ...base }
    else if (what === 'year') repeat = { freq: 'yearly', ...base }
    else {
      const days = [...what.matchAll(new RegExp(DAY_WORD, 'gi'))].map(m => dayIndex(m[1]))
      repeat = { freq: 'weekly', ...base, days: [...new Set(days)].sort((a, b) => a - b) }
    }
  }

  // How long.
  let minutes: number | null = null
  const length = take(/\bfor\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|mins?|minutes?)\b/i)
  if (length) minutes = Math.round(parseFloat(length[1]) * (length[2].toLowerCase().startsWith('h') ? 60 : 1))

  // When in the day.
  let startTime: number | null = null
  let endTime: number | null = null
  const range = take(/\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    ?? take(/\b(?:from\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:-|–|to|until)\s*(\d{1,2}):(\d{2})\s*(am|pm)?\b/i)
  if (range) {
    const endMeridiem = range[6]
    let startHour = hour24(Number(range[1]), range[3] ?? endMeridiem)
    const endHour = hour24(Number(range[4]), endMeridiem)
    // "11-1pm": the start is in the morning.
    if (!range[3] && endMeridiem && startHour > endHour) startHour -= 12
    startTime = startHour * 60 + Number(range[2] ?? 0)
    endTime = endHour * 60 + Number(range[5] ?? 0)
  } else {
    const time = take(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ?? take(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/i) ?? take(/\b(\d{1,2}):(\d{2})\b/)
    if (time) {
      let hour = hour24(Number(time[1]), time[3])
      // "at 3" with no am/pm: afternoon for 1–6.
      if (!time[3] && !time[0].includes(':') && hour >= 1 && hour <= 6) hour += 12
      startTime = hour * 60 + Number(time[2] ?? 0)
    } else if (take(/\b(?:at\s+)?noon\b/i)) startTime = 12 * 60
    else if (take(/\b(?:at\s+)?midnight\b/i)) startTime = 0
    else if (take(/\btonight\b/i)) startTime = 19 * 60
    else if (take(/\bthis\s+morning\b/i)) startTime = 9 * 60
  }

  // Which day.
  const today = startOfDay(now)
  let day: number | null = null
  let named: Date | null = null
  let match: RegExpMatchArray | null
  if (take(/\b(?:today)\b/i)) day = today
  else if (take(/\b(?:tomorrow|tmrw?|tmr)\b/i)) day = addDays(today, 1)
  else if (take(/\bday\s+after\s+tomorrow\b/i)) day = addDays(today, 2)
  else if ((match = take(/\bin\s+(\d+)\s+(days?|weeks?)\b/i))) day = addDays(today, Number(match[1]) * (match[2].toLowerCase().startsWith('w') ? 7 : 1))
  else if ((match = take(/\b(\d{4})-(\d{2})-(\d{2})\b/))) named = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  else if ((match = take(new RegExp(`\\b(?:on\\s+)?${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i')))) named = new Date(match[3] ? Number(match[3]) : new Date(now).getFullYear(), MONTHS.indexOf(match[1].toLowerCase().slice(0, 3)), Number(match[2]))
  else if ((match = take(new RegExp(`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}(?:,?\\s+(\\d{4}))?\\b`, 'i')))) named = new Date(match[3] ? Number(match[3]) : new Date(now).getFullYear(), MONTHS.indexOf(match[2].toLowerCase().slice(0, 3)), Number(match[1]))
  else if ((match = take(/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const [a, b] = [Number(match[1]), Number(match[2])]
    const [month, date] = monthFirst ? [a, b] : [b, a]
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : new Date(now).getFullYear()
    named = new Date(year, month - 1, date)
  } else if ((match = take(new RegExp(`\\b(?:on\\s+)?(next\\s+|this\\s+)?${DAY_WORD}\\b`, 'i')))) {
    const target = dayIndex(match[2])
    let ahead = (target - new Date(today).getDay() + 7) % 7
    if (match[1]?.toLowerCase().startsWith('next') && ahead === 0) ahead = 7
    if (ahead === 0 && startTime !== null && today + startTime * 60_000 < now) ahead = 7
    day = addDays(today, ahead)
  }
  if (named) {
    day = named.getTime()
    // "Dec 3" with no year that has passed means next year.
    if (day < today && !/\d{4}/.test(input)) { named.setFullYear(named.getFullYear() + 1); day = named.getTime() }
  }

  // Weekly repeats with no day given start on the first matching weekday.
  if (day === null && repeat?.freq === 'weekly' && repeat.days.length) {
    for (let i = 0; i < 8; i++) {
      const candidate = addDays(today, i)
      if (repeat.days.includes(new Date(candidate).getDay()) && (i > 0 || startTime === null || candidate + startTime * 60_000 > now)) { day = candidate; break }
    }
  }
  if (day === null) day = startTime !== null && today + startTime * 60_000 < now && !repeat ? addDays(today, 1) : today

  const title = text.replace(/\s+/g, ' ').replace(/\s+(?:on|at|from|in|for|,)$/i, '').replace(/^(?:on|at)\s+/i, '').trim() || 'New event'
  const allDay = startTime === null
  if (allDay) return { title, start: day, end: addDays(day, 1), allDay, repeat }
  const at = (mins: number) => { const d = new Date(day!); d.setHours(0, mins, 0, 0); return d.getTime() }
  const start = at(startTime!)
  let end = endTime !== null ? at(endTime) : start + (minutes ?? 60) * 60_000
  if (end <= start) end += DAY
  return { title, start, end, allDay, repeat }
}
