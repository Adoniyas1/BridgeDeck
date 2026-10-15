import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN, guessHours, planStudy } from './planner'

const H = 3_600_000
// Monday 8:00 local time.
const now = new Date(2026, 9, 12, 8, 0).getTime()
const at = (day: number, hour: number) => new Date(2026, 9, 12 + day, hour, 0).getTime()

describe('planStudy', () => {
  it('spreads the hours over the days before the deadline, a block at a time', () => {
    const { blocks, short } = planStudy([{ id: 'e', title: 'Midterm', course: 'PHYS', due: at(4, 10), hours: 4 }], [], DEFAULT_PLAN, now)
    expect(short).toEqual({})
    expect(blocks).toHaveLength(4)
    const days = new Set(blocks.map(b => new Date(b.start).getDate()))
    expect(days.size).toBe(4) // one a day, not all at once
    expect(blocks.every(b => b.end <= at(4, 8))).toBe(true) // done 2 h before
    expect(blocks.every(b => new Date(b.start).getHours() >= 9 && new Date(b.end).getHours() <= 22)).toBe(true)
  })
  it('works around what is already on the calendar and keeps to the daily limit', () => {
    const busy = [{ start: at(0, 9), end: at(0, 12) }]
    const { blocks, short } = planStudy([{ id: 'a', title: 'HW', course: '', due: at(1, 9), hours: 6 }], busy, { ...DEFAULT_PLAN, maxPerDay: 4 }, now)
    expect(blocks.some(b => b.start < at(0, 12) && b.end > at(0, 9))).toBe(false)
    expect(blocks.filter(b => new Date(b.start).getDate() === 12)).toHaveLength(4)
    expect(short).toEqual({ a: 2 }) // only today fits before 7 am tomorrow
  })
  it('does the earliest deadline first and never double-books', () => {
    const { blocks } = planStudy([
      { id: 'late', title: 'Project', course: '', due: at(3, 23), hours: 3 },
      { id: 'soon', title: 'Quiz', course: '', due: at(1, 12), hours: 2 },
    ], [], DEFAULT_PLAN, now)
    expect(blocks.filter(b => b.task === 'soon').every(b => b.end <= at(1, 10))).toBe(true)
    const sorted = [...blocks].sort((a, b) => a.start - b.start)
    sorted.slice(1).forEach((b, i) => expect(b.start).toBeGreaterThanOrEqual(sorted[i].end))
  })
  it('guesses hours from the title', () => {
    expect(guessHours('assignment', 'Final exam review')).toBe(6)
    expect(guessHours('quiz', 'Quiz 3')).toBe(2)
    expect(guessHours('assignment', 'Lab 5 report')).toBe(4)
  })
})
