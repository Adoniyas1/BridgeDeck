import { describe, expect, it } from 'vitest'
import type { Note } from '../../lib/bridge'
import { apiAnnouncements, apiAssignments, apiCourses, assignmentRemindersDue, courseMatches, notHandedIn, feedAssignments, groupAssignments, htmlText, manualAssignments, mergeCanvas, splitCourse, studyNameFor, courseKey, belongsTo, type Assignment } from './canvas'

const FEED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Instructure//Canvas//EN',
  'BEGIN:VEVENT', 'DTSTAMP:20261001T000000Z', 'DTSTART:20261010T055900Z', 'DTEND:20261010T055900Z',
  'SUMMARY:Problem Set 4 [MATH-221-01 Fall 2026]', 'UID:event-assignment-98765', 'URL;VALUE=URI:https://school.instructure.com/courses/12/assignments/98765', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261012', 'SUMMARY:Reading response [ENGL 110]', 'UID:event-assignment-555', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20261011T150000Z', 'DTEND:20261011T160000Z', 'SUMMARY:Office hours [MATH-221-01 Fall 2026]', 'UID:event-calendar-event-42', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const sample = (over: Partial<Assignment>): Assignment => ({ id: 'canvas:1', source: 'canvas', kind: 'assignment', title: 'A', course: 'MATH 221', due: null, url: '', points: null, submitted: false, missing: false, grade: '', done: false, ...over })

describe('Canvas feed', () => {
  it('reads assignments, their course, link and due time', () => {
    const list = feedAssignments(FEED)
    expect(list.map(a => [a.id, a.kind, a.title, a.course])).toEqual([
      ['canvas:98765', 'assignment', 'Problem Set 4', 'MATH-221-01 Fall 2026'],
      ['canvas:555', 'assignment', 'Reading response', 'ENGL 110'],
      ['canvas-event:42', 'event', 'Office hours', 'MATH-221-01 Fall 2026'],
    ])
    expect(list[0].due).toBe(Date.UTC(2026, 9, 10, 5, 59))
    expect(list[0].url).toBe('https://school.instructure.com/courses/12/assignments/98765')
    // A whole-day due date is due by the end of that day.
    expect(new Date(list[1].due!).getHours()).toBe(23)
    expect(new Date(list[1].due!).getDate()).toBe(12)
  })

  it('splits the course from the title', () => {
    expect(splitCourse('Lab 2 [PHYS 101]')).toEqual({ title: 'Lab 2', course: 'PHYS 101' })
    expect(splitCourse('No course here')).toEqual({ title: 'No course here', course: '' })
  })
})

describe('Canvas API', () => {
  const courses = apiCourses([
    { id: 12, name: 'Calculus III', course_code: 'MATH 221', enrollments: [{ computed_current_score: 91.25, computed_current_grade: 'A-' }] },
    { id: 13, access_restricted_by_date: true },
  ])
  it('reads courses with grades', () => {
    expect(courses).toEqual([{ id: '12', name: 'Calculus III', code: 'MATH 221', score: 91.25, grade: 'A-' }])
  })
  it('reads assignments with what was submitted', () => {
    const list = apiAssignments([
      { id: 1, name: 'Quiz 3', due_at: '2026-10-10T05:59:00Z', submission_types: ['online_quiz'], html_url: 'https://school.instructure.com/q', points_possible: 10, submission: { workflow_state: 'graded', grade: '9' } },
      { id: 2, name: 'Essay', due_at: null, submission_types: ['online_upload'], submission: { workflow_state: 'unsubmitted', missing: true } },
      { id: 3, name: 'Bad link', html_url: 'javascript:alert(1)' },
    ], courses[0])
    expect(list.map(a => [a.id, a.kind, a.submitted, a.grade, a.missing, a.due])).toEqual([
      ['canvas:1', 'quiz', true, '9', false, Date.UTC(2026, 9, 10, 5, 59)],
      ['canvas:2', 'assignment', false, '', true, null],
      ['canvas:3', 'assignment', false, '', false, null],
    ])
    expect(list[2].url).toBe('')
  })
  it('reads announcements as text, newest first', () => {
    const list = apiAnnouncements([
      { id: 1, title: 'Old', posted_at: '2026-10-01T00:00:00Z', context_code: 'course_12', message: '<p>Hi&nbsp;all</p>' },
      { id: 2, title: 'New', posted_at: '2026-10-05T00:00:00Z', context_code: 'course_12', message: '<script>x()</script><b>Exam</b> moved' },
    ], courses)
    expect(list.map(a => [a.title, a.course, a.text])).toEqual([['New', 'MATH 221', 'Exam moved'], ['Old', 'MATH 221', 'Hi all']])
    expect(htmlText('a<br>b')).toBe('a\nb')
  })
})

describe('assignment list', () => {
  it('prefers the API copy and applies done marks', () => {
    const merged = mergeCanvas([sample({ id: 'canvas:1', url: 'https://x/1' }), sample({ id: 'canvas:2' })], [sample({ id: 'canvas:1', title: 'From API', submitted: true })], ['canvas:2'])
    expect(merged.map(a => [a.id, a.title, a.url, a.done])).toEqual([['canvas:1', 'From API', 'https://x/1', true], ['canvas:2', 'A', '', true]])
  })

  it('groups by when things are due', () => {
    const now = new Date(2026, 9, 7, 12).getTime()
    const at = (days: number, hour = 12) => new Date(2026, 9, 7 + days, hour).getTime()
    const groups = groupAssignments([
      sample({ id: 'late', due: at(-1) }), sample({ id: 'ancient', due: at(-30) }), sample({ id: 'tonight', due: at(0, 23) }),
      sample({ id: 'friday', due: at(3) }), sample({ id: 'next-month', due: at(30) }), sample({ id: 'someday' }),
      sample({ id: 'finished', due: at(1), done: true }), sample({ id: 'office', kind: 'event', due: at(1) }),
    ], now)
    expect(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map(a => a.id)]))).toEqual({
      overdue: ['late'], today: ['tonight'], week: ['friday'], later: ['next-month'], undated: ['someday'], done: ['finished'],
    })
  })

  it('reminds the chosen hours before and an hour before, once each', () => {
    const due = Date.UTC(2026, 9, 10, 5, 59)
    const list = [sample({ due }), sample({ id: 'canvas:2', due, done: true })]
    const seen = new Set<string>()
    expect(assignmentRemindersDue(list, due - 24 * 3_600_000, 24, seen).map(r => r.lead)).toEqual([1440])
    expect(assignmentRemindersDue(list, due - 24 * 3_600_000 + 60_000, 24, seen)).toEqual([])
    expect(assignmentRemindersDue(list, due - 3_600_000, 24, seen).map(r => r.lead)).toEqual([60])
    // Missed by more than ten minutes (asleep): not sent late.
    expect(assignmentRemindersDue([sample({ id: 'canvas:3', due })], due - 30 * 60_000, 24, new Set())).toEqual([])
  })

  it('reads assignments added by hand from the Assignments note', () => {
    const note = { id: 'n1', title: 'Assignments', folder: 'Study', deleted: false, blocks: [
      { id: 'b1', kind: 'todo', text: 'Math 221: Problem set 5', checked: false, due: 123, pos: 'a', updated: 0, by: '', deleted: false },
      { id: 'b2', kind: 'todo', text: 'Buy a calculator', checked: true, due: null, pos: 'b', updated: 0, by: '', deleted: false },
    ] } as unknown as Note
    expect(manualAssignments([note]).map(a => [a.id, a.course, a.title, a.due, a.done])).toEqual([
      ['manual:b1', 'Math 221', 'Problem set 5', 123, false],
      ['manual:b2', '', 'Buy a calculator', null, true],
    ])
  })

  it('matches Canvas course names to Study courses', () => {
    expect(courseMatches('Math 221', 'MATH-221-01 Fall 2026')).toBe(true)
    expect(courseMatches('Math 221', 'MATH 222')).toBe(false)
    expect(courseMatches('Biology', 'Intro Biology')).toBe(true)
  })
})

describe('studyNameFor', () => {
  it('makes short course names from Canvas codes', () => {
    expect(studyNameFor({ code: 'E E 201 Sec05', name: 'Electric Circuits' })).toBe('EE 201')
    expect(studyNameFor({ code: 'MATH-221-01 Fall 2026', name: 'Calculus III' })).toBe('MATH 221')
    expect(studyNameFor({ code: 'Orientation', name: 'New Student Orientation' })).toBe('New Student Orientation')
  })
})

describe('course codes', () => {
  it('reads catalog codes from Canvas and Study names', () => {
    expect(courseKey('E E 201 Sec05')).toBe('EE 201')
    expect(courseKey('MATH-224-01 Fall 2026')).toBe('MATH 224')
    expect(courseKey('EE 370L Control Lab')).toBe('EE 370L')
    expect(courseKey('C E C S 174 Sec 02')).toBe('CECS 174')
    expect(courseKey('Calc 3')).toBeNull()
    expect(courseKey('Fall 2026 Orientation')).toBeNull()
  })
  it('matches Canvas courses to Study courses by code or link', () => {
    expect(courseMatches('EE 201', 'E E 201 Sec05')).toBe(true)
    expect(courseMatches('EE 201', 'E E 202 Sec01')).toBe(false)
    expect(belongsTo({ name: 'Calc 3', code: 'MATH 224' }, 'MATH 224 Sec 07')).toBe(true)
    expect(belongsTo({ name: 'Calc 3', canvasCode: 'Calculus III - Fall 26' }, 'Calculus III - Fall 26')).toBe(true)
    expect(belongsTo({ name: 'Calc 3' }, 'E E 201 Sec05')).toBe(false)
  })
})

describe('handed in on Canvas', () => {
  const base = { source: 'canvas' as const, kind: 'assignment' as const, title: 'HW 4', course: 'EE 310', url: '', points: 10, missing: false, grade: '' }
  const now = Date.UTC(2026, 9, 22, 12)
  it('warns about work ticked done here that Canvas has no submission for', () => {
    const list = [
      { ...base, id: 'a', due: now - 3_600_000, submitted: false, done: true, online: true },
      { ...base, id: 'b', due: now - 3_600_000, submitted: true, done: true, online: true },
      { ...base, id: 'c', due: now - 3_600_000, submitted: false, done: true, online: false },
      { ...base, id: 'd', due: now + 86_400_000, submitted: false, done: true, online: true },
      { ...base, id: 'e', due: now - 30 * 86_400_000, submitted: false, done: true, online: true },
    ]
    expect(notHandedIn(list, now).map(a => a.id)).toEqual(['a'])
  })
})
