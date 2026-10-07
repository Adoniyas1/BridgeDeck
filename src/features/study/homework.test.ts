import { describe, expect, it } from 'vitest'
import { dateHomework, homeworkTitle, mondayOf, readHomework } from './homework'

const ANSWER = `Here it is:
\`\`\`
SEMESTER | 08/24/2026 | 12/11/2026
WEEK | DAY | WORK | NOTE
| M 1 | Ch 10.1: 3, 7-15 (odd), 18; Ch 10.2: 2, 5 | |
1 | W 2 | Ch 10.3: 1-21 (odd), 22 | |
 | Th 3 | Ch 10.4: 3, 5, 7 | |
 | M 4 | Ch 10.5: 1, 5 | |
2 | W 5 | Ch 10.7: 1-9 (odd) | |
 | Th 6 | Ch 10.8: 1, 3 | |
3 | W 7 | Ch 10.9: 3, 7, 13a | Labor Day |
 | Th 8 | Ch 10.9: 27, 31 | |
4 | M 12 | Ch 11.2: 5, 7 | Exam 1 |
\`\`\``

const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA')

describe('homework from a photo', () => {
  it('reads ChatGPT’s lines and the semester', () => {
    const { rows, semesterStart } = readHomework(ANSWER)
    expect(rows).toHaveLength(9)
    expect(day(semesterStart!)).toBe('2026-08-24')
    expect(rows[0]).toEqual({ week: null, day: 1, label: 'M 1', text: 'Ch 10.1: 3, 7-15 (odd), 18; Ch 10.2: 2, 5', note: '' })
    expect(rows[6].note).toBe('Labor Day')
    expect(homeworkTitle(rows[1])).toBe('W 2 · Ch 10.3: 1-21 (odd), 22')
  })
  it('dates class days by week, skipping holidays', () => {
    const { rows, semesterStart } = readHomework(ANSWER)
    const dated = dateHomework(rows, semesterStart!).map(r => `${r.label} ${day(r.date)}`)
    expect(dated).toEqual(['M 1 2026-08-24', 'W 2 2026-08-26', 'Th 3 2026-08-27', 'M 4 2026-08-31', 'W 5 2026-09-02', 'Th 6 2026-09-03',
      'W 7 2026-09-09', 'Th 8 2026-09-10', 'M 12 2026-09-14'])
  })
  it('works without the week column, and counts weeks from the weekday order', () => {
    const { rows } = readHomework('M 1 | a |\nW 2 | b |\nM 3 | c |\nTh 4 | d | Exam')
    expect(dateHomework(rows, new Date(2026, 0, 14).getTime()).map(r => day(r.date))).toEqual(['2026-01-12', '2026-01-14', '2026-01-19', '2026-01-22'])
    expect(day(mondayOf(new Date(2026, 7, 30).getTime()))).toBe('2026-08-24')
  })
})
