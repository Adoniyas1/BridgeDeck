import { describe, expect, it } from 'vitest'
import type { CalEvent } from '../../lib/bridge'
import { fromIcs, parseTime, toIcs } from './ics'
import { DAY, layoutDay, monthGrid, startOfWeek, type Item } from './model'
import { parseQuickAdd } from './quickadd'
import { describeRepeat, occurrences } from './recur'
import { itemsBetween, remindersDue } from './state'

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const event = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: 'e', title: 'Event', start: at(2026, 10, 5, 9), end: at(2026, 10, 5, 10), allDay: false, location: '', notes: '', color: 'blue',
  repeat: null, skip: [], reminder: null, updated: 0, by: '', deleted: false, seq: 0, ...over,
})
const starts = (e: CalEvent, from: number, to: number) => occurrences(e, from, to).map(o => new Date(o.start).toDateString())

describe('repeating events', () => {
  it('repeats weekly on chosen weekdays, skipping removed occurrences, and stops after a count', () => {
    // Monday 5 Oct 2026, every Mon/Wed/Fri.
    const e = event({ repeat: { freq: 'weekly', interval: 1, days: [1, 3, 5], until: null, count: null }, skip: [at(2026, 10, 7, 9)] })
    expect(starts(e, at(2026, 10, 1), at(2026, 10, 12))).toEqual(['Mon Oct 05 2026', 'Fri Oct 09 2026'])
    const counted = { ...e, skip: [], repeat: { ...e.repeat!, count: 4 } }
    expect(occurrences(counted, at(2026, 10, 1), at(2026, 12, 1))).toHaveLength(4)
    expect(describeRepeat(e)).toBe('Every week on Mon, Wed, Fri')
  })

  it('keeps the same clock time and skips months without that day', () => {
    const e = event({ start: at(2026, 1, 31, 8), end: at(2026, 1, 31, 9), repeat: { freq: 'monthly', interval: 1, days: [], until: null, count: null } })
    const found = occurrences(e, at(2026, 1, 1), at(2026, 6, 1))
    expect(found.map(o => new Date(o.start).getMonth() + 1)).toEqual([1, 3, 5])
    expect(found.every(o => new Date(o.start).getHours() === 8)).toBe(true)
  })

  it('finds today’s occurrence of a daily event that started years ago, quickly', () => {
    const e = event({ start: at(2010, 1, 1, 7), end: at(2010, 1, 1, 8), repeat: { freq: 'daily', interval: 1, days: [], until: null, count: null } })
    expect(starts(e, at(2026, 10, 5), at(2026, 10, 6))).toEqual(['Mon Oct 05 2026'])
    const ended = { ...e, repeat: { ...e.repeat!, until: at(2020, 1, 1) } }
    expect(occurrences(ended, at(2026, 10, 5), at(2026, 10, 6))).toEqual([])
  })
})

describe('quick add', () => {
  const now = at(2026, 10, 1, 10) // Thursday 10:00

  it('reads a day, a time and a length', () => {
    const e = parseQuickAdd('Lunch with Sam tomorrow at 1pm for 90m', now)
    expect(e.title).toBe('Lunch with Sam')
    expect([e.start, e.end, e.allDay]).toEqual([at(2026, 10, 2, 13), at(2026, 10, 2, 14, 30), false])
  })

  it('reads weekdays, ranges, dates and repeats', () => {
    const fri = parseQuickAdd('Dentist fri 3:30pm', now)
    expect([fri.title, fri.start]).toEqual(['Dentist', at(2026, 10, 2, 15, 30)])
    const range = parseQuickAdd('Gym every mon wed fri 7-8am', now)
    expect([range.title, range.start, range.end]).toEqual(['Gym', at(2026, 10, 2, 7), at(2026, 10, 2, 8)])
    expect(range.repeat).toEqual({ freq: 'weekly', interval: 1, days: [1, 3, 5], until: null, count: null })
    const birthday = parseQuickAdd('Mum’s birthday Dec 3 every year', now)
    expect([birthday.title, birthday.start, birthday.allDay, birthday.repeat?.freq]).toEqual(['Mum’s birthday', at(2026, 12, 3), true, 'yearly'])
    const standup = parseQuickAdd('Standup every weekday 9:15', now)
    expect([standup.title, standup.start, standup.repeat?.days]).toEqual(['Standup', at(2026, 10, 2, 9, 15), [1, 2, 3, 4, 5]])
    expect(parseQuickAdd('Call 10/5 6pm', now, true).start).toBe(at(2026, 10, 5, 18))
    expect(parseQuickAdd('Call 10/5 6pm', now, false).start).toBe(at(2027, 5, 10, 18))
    expect(parseQuickAdd('Trip Jan 4', now).start).toBe(at(2027, 1, 4))
  })

  it('puts a time that has passed today on tomorrow', () => {
    const e = parseQuickAdd('Coffee 8am', now)
    expect(e.start).toBe(at(2026, 10, 2, 8))
    expect(parseQuickAdd('Read', now)).toMatchObject({ title: 'Read', allDay: true, start: at(2026, 10, 1) })
  })
})

describe('iCalendar', () => {
  it('round-trips events, repeats, skips and reminders', () => {
    const events = [
      event({ id: 'a', title: 'Team, sync; weekly', notes: 'line 1\nline 2', repeat: { freq: 'weekly', interval: 2, days: [2, 4], until: null, count: 10 }, skip: [at(2026, 10, 6, 9)], reminder: 15 }),
      event({ id: 'b', title: 'Holiday', start: at(2026, 12, 24), end: at(2026, 12, 26), allDay: true }),
    ]
    const text = toIcs(events, at(2026, 10, 1))
    expect(text.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75)).toBe(true)
    const back = fromIcs(text)
    expect(back.map(e => e.id)).toEqual(['ics-abridgedeck', 'ics-bbridgedeck'])
    expect(back[0]).toMatchObject({ title: 'Team, sync; weekly', notes: 'line 1\nline 2', start: events[0].start, end: events[0].end, reminder: 15, skip: [at(2026, 10, 6, 9)] })
    expect(back[0].repeat).toEqual({ freq: 'weekly', interval: 2, days: [2, 4], until: null, count: 10 })
    expect(back[1]).toMatchObject({ allDay: true, start: at(2026, 12, 24), end: at(2026, 12, 26) })
  })

  it('reads other apps’ files: folded lines, time zones, durations and changed occurrences', () => {
    const text = [
      'BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:abc123@google.com', 'DTSTART;TZID=America/New_York:20261005T090000', 'DURATION:PT45M',
      'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Long title that is folded ac', ' ross two lines', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:abc123@google.com', 'RECURRENCE-ID;TZID=America/New_York:20261012T090000', 'DTSTART;TZID=America/New_York:20261012T100000',
      'DTEND;TZID=America/New_York:20261012T110000', 'SUMMARY:Moved', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n')
    const [series, moved] = fromIcs(text)
    expect(series.title).toBe('Long title that is folded across two lines')
    expect(series.start).toBe(Date.UTC(2026, 9, 5, 13))
    expect(series.end - series.start).toBe(45 * 60_000)
    expect(series.reminder).toBe(10)
    expect(series.skip).toEqual([Date.UTC(2026, 9, 12, 13)])
    expect(moved.title).toBe('Moved')
    expect(moved.repeat).toBeNull()
    expect(parseTime('20261005T090000Z')).toEqual({ ms: Date.UTC(2026, 9, 5, 9), allDay: false })
  })
})

describe('layout', () => {
  it('puts overlapping events side by side', () => {
    const item = (key: string, h1: number, h2: number): Item => ({ key, source: 'event', title: key, start: at(2026, 10, 5, h1), end: at(2026, 10, 5, h2), allDay: false, color: 'blue' })
    const placed = layoutDay([item('a', 9, 11), item('b', 10, 12), item('c', 13, 14)])
    expect(placed.map(p => [p.item.key, p.column, p.columns])).toEqual([['a', 0, 2], ['b', 1, 2], ['c', 0, 1]])
  })

  it('builds weeks from the chosen first weekday', () => {
    expect(new Date(startOfWeek(at(2026, 10, 1), 1)).getDate()).toBe(28)
    const grid = monthGrid(at(2026, 10, 15), 0)
    expect(grid).toHaveLength(42)
    expect(new Date(grid[0]).toDateString()).toBe('Sun Sep 27 2026')
    expect(Math.round((grid[41] - grid[0]) / DAY)).toBe(41)
  })
})

describe('reminders and items', () => {
  it('reminds once at the chosen lead time, and not long after a missed one', () => {
    const daily = event({ reminder: 10, start: at(2026, 10, 1, 9), end: at(2026, 10, 1, 10), repeat: { freq: 'daily', interval: 1, days: [], until: null, count: null } })
    const seen = new Set<string>()
    expect(remindersDue([daily], at(2026, 10, 5, 8, 45), seen)).toEqual([])
    expect(remindersDue([daily], at(2026, 10, 5, 8, 50), seen).map(r => r.start)).toEqual([at(2026, 10, 5, 9)])
    expect(remindersDue([daily], at(2026, 10, 5, 8, 51), seen)).toEqual([])
    // Waking up at noon: the 8:50 reminder is too old to send.
    expect(remindersDue([daily], at(2026, 10, 6, 12), new Set())).toEqual([])
  })

  it('shows events, due checklist items and Apple items together', () => {
    const note = { id: 'n', title: 'Errands', folder: '', pinned: false, kind: 'list' as const, created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, seq: 0,
      blocks: [{ id: 'b', kind: 'todo' as const, text: 'Post office', checked: false, due: at(2026, 10, 5, 12), pos: 'i', updated: 0, by: '', deleted: false }] }
    const apple = [{ id: 'x', kind: 'event' as const, title: 'Flight', start: at(2026, 10, 5), end: at(2026, 10, 6), allDay: true, calendar: 'Travel', location: '', from: 'Mac' }]
    const items = itemsBetween([event()], [note], apple, at(2026, 10, 5), at(2026, 10, 6))
    expect(items.map(i => [i.source, i.title])).toEqual([['apple', 'Flight'], ['event', 'Event'], ['todo', 'Post office']])
  })
})
