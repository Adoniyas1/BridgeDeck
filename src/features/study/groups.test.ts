import { describe, expect, it } from 'vitest'
import { clockText, freeSlots, parseBusy } from './groups'

describe('study groups', () => {
  it('reads typed class times', () => {
    expect(parseBusy('MW 10:00-11:15, TuTh 2-3:15pm; F 9-12; whenever')).toEqual([
      { days: [1, 3], start: 600, end: 675 }, { days: [2, 4], start: 840, end: 915 }, { days: [5], start: 540, end: 720 },
    ])
  })
  it('finds when everyone is free', () => {
    const slots = freeSlots([{ days: [1], start: 600, end: 675 }, { days: [1], start: 660, end: 780 }, { days: [2, 3, 4, 5], start: 480, end: 1200 }], 480, 1200, 60)
    expect(slots.map(s => `${s.day} ${clockText(s.start)}-${clockText(s.end)}`)).toEqual(['1 8am-10am', '1 1pm-8pm'])
  })
})

describe('a partner’s calendar file', () => {
  it('turns a week of their events into hours, which read back the same', async () => {
    const { busyFromEvents, busyText, parseBusy } = await import('./groups')
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
    const ev = (id: string, start: number, end: number, weekly: boolean, allDay = false) => ({ id, title: id, start, end, allDay, location: '', notes: '', color: '', repeat: weekly ? { freq: 'weekly' as const, interval: 1, days: [], until: null, count: null } : null, skip: [], reminder: null, updated: 0, by: '', deleted: false, seq: 0 })
    // Monday 19 Oct 2026: MW 10:00-11:15 (two weekly events), Thursday 14:00-15:15 once, an all-day event.
    const events = [ev('a', at(19, 10), at(19, 11, 15), true), ev('b', at(21, 10), at(21, 11, 15), true), ev('c', at(29, 14), at(29, 15, 15), false), ev('d', at(27, 0), at(28, 0), false, true)]
    const busy = busyFromEvents(events as never, at(26, 0))
    const text = busyText(busy)
    expect(text).toBe('MW 10:00-11:15, Th 14:00-15:15')
    expect(parseBusy(text)).toEqual([{ days: [1, 3], start: 600, end: 675 }, { days: [4], start: 840, end: 915 }])
  })
})
