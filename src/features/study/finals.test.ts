import { describe, expect, it } from 'vitest'
import { finalFor, readFinals } from './finals'

const PASTED = `Class Meeting Days and Time | Final Exam Day and Date | Final Exam Time
MW 8:00 AM | Wednesday, December 17 | 7:45 - 9:45 AM
MW 9:30 AM | Monday, December 15 | 10:15 AM - 12:15 PM
TuTh 2:00 PM | Thursday, Dec 18 | 2:45 - 4:45 PM
Something else entirely`

describe('finals schedule', () => {
  it('reads the rows', () => {
    const rows = readFinals(PASTED)
    expect(rows.map(r => [r.days.join(''), r.start, r.date.month, r.date.day, r.from, r.to])).toEqual([
      ['13', 480, 11, 17, 465, 585], ['13', 570, 11, 15, 615, 735], ['24', 840, 11, 18, 885, 1005],
    ])
  })
  it('finds a course’s final from its lecture time', () => {
    const rows = readFinals(PASTED)
    const f = finalFor([{ days: [2, 4], start: '14:00', end: '15:15', room: 'VEC 115', kind: '' }, { days: [5], start: '08:00', end: '10:45', room: '', kind: 'lab' }], rows, 2026)!
    expect(new Date(f.start).toString()).toContain('Dec 18 2026 14:45')
    expect(finalFor([{ days: [1, 3], start: '09:45', end: '11:00', room: '', kind: '' }], rows, 2026)).not.toBeNull()
    expect(finalFor([{ days: [5], start: '09:00', end: '10:00', room: '', kind: '' }], rows, 2026)).toBeNull()
  })
})

describe('reading the schedule page', () => {
  it('turns its table into rows readFinals takes', async () => {
    const { tableText } = await import('./finals')
    const html = '<html><style>td{}</style><table><tr><th>Class</th><th>Exam</th><th>Time</th></tr><tr><td>TuTh&nbsp;2:00 PM</td><td>Thursday, Dec 18</td><td>2:45 &ndash; 4:45 PM</td></tr></table></html>'
    const text = tableText(html)
    expect(text).toBe('Class | Exam | Time\nTuTh 2:00 PM | Thursday, Dec 18 | 2:45 – 4:45 PM')
    expect(readFinals(text)).toHaveLength(1)
  })
})
