import { describe, expect, it } from 'vitest'
import type { CalEvent } from '../../lib/bridge'
import { bringList, examNoticesDue, examNotes, examNotesText, examsFrom, leaveBy } from './exams'

const event = (over: Partial<CalEvent>): CalEvent => ({ id: 'e', title: '', start: 0, end: 0, allDay: false, location: '', notes: '', color: '', repeat: null, skip: [], reminder: null, updated: 0, by: '', deleted: false, seq: 0, ...over })
const now = new Date(2026, 9, 22, 9).getTime()
const day = (d: number, h = 10) => new Date(2026, 9, d, h).getTime()
const courses = [{ name: 'EE 310', info: { code: 'EE 310', canvasCode: 'EE-310-01' } }]

describe('exams', () => {
  it('come from the calendar and Canvas, once each', () => {
    const exams = examsFrom([
      event({ id: 'a', title: 'EE 310: Midterm 2', start: day(30), end: day(30, 12), location: 'ECS 105', color: 'red', notes: examNotesText('one formula sheet, calculator', 'Ch 4-6') }),
      event({ id: 'b', title: 'EE 310 office hours', start: day(25), end: day(25, 11) }),
      event({ id: 'c', title: 'Dentist', start: day(26), end: day(26, 11), color: 'red' }),
    ], [
      { id: 'canvas:1', source: 'canvas', kind: 'quiz', title: 'Midterm 2', course: 'EE-310-01', due: day(30, 11), url: '', points: null, submitted: false, missing: false, grade: '', done: false },
      { id: 'canvas:2', source: 'canvas', kind: 'quiz', title: 'Final exam', course: 'EE-310-01', due: day(15, 11) + 40 * 86_400_000, url: '', points: null, submitted: false, missing: false, grade: '', done: false },
    ], courses, now)
    expect(exams.map(e => [e.course, e.title, e.source])).toEqual([['EE 310', 'Midterm 2', 'calendar'], ['EE 310', 'Final exam', 'canvas']])
    expect(exams[0]).toMatchObject({ room: 'ECS 105', allowed: 'one formula sheet, calculator', covers: 'Ch 4-6' })
  })
  it('know what to bring', () => {
    expect(examNotes('Allowed: calculator\nCovers: ch 1')).toEqual({ allowed: 'calculator', covers: 'ch 1' })
    expect(bringList('one formula sheet, calculator')).toContain('Calculator (fresh battery)')
    expect(bringList('one formula sheet, calculator')).toContain('Formula sheet')
  })
})

describe('exam-day notices', () => {
  const exam = { id: 'x', course: 'EE 310', title: 'Midterm', start: new Date(2026, 9, 30, 10).getTime(), end: 0, room: 'ECS 105', allowed: '', covers: '', source: 'calendar' as const }
  it('come the evening before and at leave-by time, once', () => {
    expect(new Date(leaveBy(exam, 30))).toEqual(new Date(2026, 9, 30, 9, 15))
    expect(examNoticesDue([exam], new Date(2026, 9, 29, 21, 40).getTime(), 30, new Set()).map(n => n.kind)).toEqual(['evening'])
    expect(examNoticesDue([exam], new Date(2026, 9, 30, 9, 20).getTime(), 30, new Set()).map(n => n.kind)).toEqual(['leave'])
    expect(examNoticesDue([exam], new Date(2026, 9, 30, 9, 20).getTime(), 30, new Set(['x:leave']))).toEqual([])
    expect(examNoticesDue([exam], new Date(2026, 9, 29, 12).getTime(), 30, new Set())).toEqual([])
  })
})
