import { describe, expect, it } from 'vitest'
import { categoryPercent, currentPercent, letterFor, neededAverage, neededOn, readGrading } from './grades'

const g = readGrading({ categories: [
  { id: 'hw', name: 'Homework', weight: 20, items: [{ id: 'h1', name: 'HW 1', got: 9, max: 10 }, { id: 'h2', name: 'HW 2', got: 10, max: 10 }] },
  { id: 'ex', name: 'Exams', weight: 50, items: [{ id: 'e1', name: 'Exam 1', got: 72, max: 100 }, { id: 'e2', name: 'Exam 2', got: null, max: 100 }] },
  { id: 'fi', name: 'Final', weight: 30, items: [{ id: 'f', name: 'Final', got: null, max: 100 }] },
] })

describe('grades', () => {
  it('works out the current grade from what is graded', () => {
    expect(categoryPercent(g.categories[0])).toBeCloseTo(95)
    // (95·20 + 72·50) / 70
    expect(currentPercent(g)).toBeCloseTo(78.571, 2)
    expect(letterFor(78.57)).toBe('C')
    expect(letterFor(90)).toBe('A')
  })
  it('solves for the score needed on an ungraded item', () => {
    // With the final at x: (95·20 + 72·50 + x·30) / 100 = 80 → x = 83.33
    expect(neededOn(g, 'f', 80)).toBeCloseTo(83.33, 1)
    // Exam 2 joins Exam 1 (by points): exams = (72 + x) / 2; (1900 + 25·(72 + x)) / 70 = 80
    expect(neededOn(g, 'e2', 80)).toBeCloseTo(76, 1)
    expect(neededOn(g, 'nope', 80)).toBeNull()
    // Everything left at p%: (95·20 + (72 + p)/2·50 + p·30) / 100 = 80 → 55p = 4300 → p = 78.2
    expect(neededAverage(g, 80)).toBeCloseTo(78.18, 1)
    expect(neededAverage({ categories: [{ id: 'a', name: 'A', weight: 100, items: [{ id: 'x', name: 'x', got: 5, max: 10 }] }] }, 80)).toBeNull()
  })
  it('reads saved grading, dropping junk', () => {
    expect(readGrading({ categories: [{ name: 'X', weight: 'a', items: [{ name: 'q', got: 'z', max: 5 }, 7] }, null] }).categories).toEqual([{ id: expect.any(String), name: 'X', weight: 0, items: [{ id: expect.any(String), name: 'q', got: null, max: 5 }] }])
  })
})
