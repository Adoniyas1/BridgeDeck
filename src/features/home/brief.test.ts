import { describe, expect, it } from 'vitest'
import type { CalEvent, Note, NoteBlock, TransferStatus } from '../../lib/bridge'
import { awayIsEmpty, briefLine, buildBrief, dailyDue, eveningNudge, whileAway } from './brief'

const at = (d: number, h = 9) => new Date(2026, 9, d, h).getTime()
const ev = (title: string, start: number, extra: Partial<CalEvent> = {}): CalEvent => ({ id: title, title, start, end: start + 3_600_000, allDay: false, location: '', notes: '', color: 'blue', repeat: null, skip: [], reminder: null, updated: 1, by: 'mac', deleted: false, seq: 1, ...extra })
const blk = (id: string, text: string, extra: Partial<NoteBlock> = {}): NoteBlock => ({ id, kind: 'todo', text, checked: false, due: null, pos: id, updated: 1, by: 'mac', deleted: false, ...extra })
const note = (id: string, title: string, folder: string, blocks: NoteBlock[]): Note => ({ id, title, folder, pinned: false, kind: 'list', created: 1, titleUpdated: 1, metaUpdated: 1, deleted: false, seq: 1, blocks })

describe('brief', () => {
  const now = at(2, 8)
  const events = [ev('Lecture', at(2, 10)), ev('Studied Math 221', at(2, 7)), ev('Math 221: Midterm', at(4, 9)), ev('Robot: Demo', at(8, 9), { allDay: true }), ev('Dentist', at(5)), ev('Gym', at(1, 18), { repeat: { freq: 'daily', interval: 1, days: [], until: null, count: null } })]
  const notes = [
    note('t', 'Todo', '', [blk('a', 'Pay rent', { due: at(1, 12) }), blk('b', 'Email prof', { due: at(2, 17) }), blk('c', 'Next week', { due: at(9) })]),
    note('f', 'Math 221 — flashcards', 'Study/Math 221', [blk('q1', 'Limit? :: approach', { kind: 'li' }), blk('q2', 'Chain rule? :: f(g)g', { kind: 'li' })]),
  ]
  const brief = buildBrief({ now, events, notes, courses: ['Math 221'], projects: ['Robot'] })

  it('gathers today, what is due, exams and milestones coming up, and cards to review', () => {
    expect(brief.today.map(t => t.title)).toEqual(['Lecture', 'Gym'])
    expect(brief.due.map(d => [d.text, d.overdue])).toEqual([['Pay rent', true], ['Email prof', false]])
    expect(brief.soon.map(s => [s.title, s.days, s.kind])).toEqual([['Math 221: Midterm', 2, 'exam'], ['Robot: Demo', 6, 'milestone']])
    expect(brief.cards).toEqual([{ course: 'Math 221', due: 2 }])
    expect(briefLine(brief)).toBe('2 events, 2 tasks due (1 overdue), Math 221: Midterm in 2 days, 2 cards to review')
    expect(eveningNudge(brief)).toBe('Math 221: Midterm in 2 days. 2 flashcards to review (Math 221 2)')
    expect(briefLine(buildBrief({ now, events: [], notes: [], courses: [], projects: [] }))).toBe('A clear day: nothing scheduled or due.')
    expect(eveningNudge(buildBrief({ now, events: [], notes: [], courses: [], projects: [] }))).toBeNull()
  })

  it('gives each daily notice once, on time and not hours late', () => {
    expect(dailyDue('08:00', at(2, 7), '')).toBe(false)
    expect(dailyDue('08:00', at(2, 8) + 60_000, '')).toBe(true)
    expect(dailyDue('08:00', at(2, 8) + 60_000, new Date(at(2)).toDateString())).toBe(false)
    expect(dailyDue('08:00', at(2, 12), '')).toBe(false)
  })

  it('tells what the other computer changed while you were away', () => {
    const since = at(1, 20)
    const changed = [note('n', 'Thesis', '', [blk('x', 'Ch 1', { by: 'pc', updated: at(2, 1) }), blk('y', 'Ch 2', { by: 'pc', updated: at(2, 2) }), blk('z', 'Mine', { by: 'mac', updated: at(2, 3) })])]
    const transfers = [{ direction: 'receive', state: 'done', finishedAt: at(2, 6), names: ['lab.pdf'], peerName: 'PC' }, { direction: 'send', state: 'done', finishedAt: at(2, 6), names: ['x'], peerName: 'PC' }] as TransferStatus[]
    const away = whileAway(since, 'mac', changed, [ev('Party', at(6), { by: 'pc', updated: at(2, 4) }), ev('Old', at(6), { by: 'pc', updated: at(1) })], transfers)
    expect(away.notes).toEqual([{ id: 'n', title: 'Thesis', changes: 2 }])
    expect(away.events.map(e => e.title)).toEqual(['Party'])
    expect(away.files).toEqual([{ names: ['lab.pdf'], from: 'PC' }])
    expect(awayIsEmpty(whileAway(at(3), 'mac', changed, [], []))).toBe(true)
  })
})
