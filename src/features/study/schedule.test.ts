import { describe, expect, it } from 'vitest'
import { classDaysOf, classesBetween, meetingsOf, meetingText, nextClass, readTerm, termFirstMonday } from './schedule'

const term = readTerm(JSON.stringify({ start: '2026-08-24', end: '2026-12-11', breaks: [{ start: '2026-09-07', end: '2026-09-07', name: 'Labor Day' }, { start: '2026-11-23', end: '2026-11-27', name: 'Fall break' }] }))!
const ee = { name: 'EE 201', info: { title: 'Digital Logic Design', meetings: [{ days: [1, 3], start: '10:00', end: '11:15', room: 'ECS 302', kind: 'Lecture' }, { days: [5], start: '13:00', end: '15:45', room: 'ECS 405', kind: 'Lab' }] } }
const day = (ms: number) => new Date(ms).toLocaleString('en-CA', { hour12: false }).slice(0, 17)

describe('class schedule', () => {
  it('reads meetings and the term', () => {
    expect(meetingsOf({ meetings: [{ days: [3, 1, 9], start: '10:00', end: '11:15' }, { days: [], start: 'x', end: 'y' }] })).toEqual([{ days: [1, 3], start: '10:00', end: '11:15', room: '', kind: '' }])
    expect(meetingText(meetingsOf(ee.info)[0])).toBe('MW 10:00–11:15 · ECS 302')
    expect(readTerm('nope')).toBeNull()
    expect(new Date(termFirstMonday(term)!).getDate()).toBe(24)
  })
  it('lists classes, skipping breaks and days outside the semester', () => {
    const week = classesBetween([ee], term, new Date(2026, 8, 7).getTime(), new Date(2026, 8, 12).getTime())
    expect(week.map(c => day(c.start))).toEqual(['2026-09-09, 10:00', '2026-09-11, 13:00'])
    expect(classesBetween([ee], term, new Date(2026, 11, 14).getTime(), new Date(2026, 11, 20).getTime())).toEqual([])
    const next = nextClass([ee], term, new Date(2026, 8, 9, 10, 30).getTime())!
    expect([next.room, day(next.start)]).toEqual(['ECS 302', '2026-09-09, 10:00'])
    expect(day(nextClass([ee], term, new Date(2026, 8, 9, 12).getTime())!.start)).toBe('2026-09-11, 13:00')
  })
  it('lists a course’s class days for due dates', () => {
    const days = classDaysOf(ee.info, term)
    expect(days.slice(0, 4).map(d => day(d).slice(0, 10))).toEqual(['2026-08-24', '2026-08-26', '2026-08-28', '2026-08-31'])
    expect(days.some(d => day(d).startsWith('2026-09-07'))).toBe(false)
  })
})
