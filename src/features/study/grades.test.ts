import { describe, expect, it } from 'vitest'
import { categoryPercent, currentPercent, letterFor, neededAverage, neededOn, readGrading, categoryFor, withCanvasScores } from './grades'

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

describe('syllabus rules and Canvas scores', () => {
  const hw = (got: number | null, max = 10, extra = false) => ({ id: `${got}-${max}-${extra}`, name: 'HW', got, max, ...(extra ? { extra: true } : {}) })
  it('drops the lowest, counts extra credit, and adds up points', () => {
    const c = { id: 'h', name: 'Homework', weight: 100, items: [hw(10), hw(2), hw(8), hw(3, 0, true)], drop: 1 }
    expect(categoryPercent(c)).toBeCloseTo((10 + 8 + 3) / 20 * 100)
    const points = { mode: 'points' as const, categories: [{ id: 'a', name: 'A', weight: 0, items: [hw(9, 10)] }, { id: 'b', name: 'B', weight: 0, items: [hw(40, 50)] }] }
    expect(currentPercent(points)).toBeCloseTo(49 / 60 * 100)
    expect(readGrading({ categories: [{ name: 'x', weight: 1, drop: 2.7, items: [{ name: 'a', extra: true, canvasId: 'canvas:1' }] }], mode: 'points', goal: 85 })).toMatchObject({ mode: 'points', goal: 85, categories: [{ drop: 2, items: [{ extra: true, canvasId: 'canvas:1' }] }] })
  })
  it('fills in Canvas scores by link, by name, or by the category the name suggests', () => {
    const g = { categories: [{ id: 'h', name: 'Homework', weight: 20, items: [{ id: 'i1', name: 'HW 1', got: null, max: 10 }] }, { id: 'e', name: 'Midterms', weight: 50, items: [] }, { id: 'f', name: 'Final', weight: 30, items: [] }] }
    let n = 0
    const { grading, filled } = withCanvasScores(g, [
      { id: 'canvas:1', title: 'HW 1', score: 9, points: 10 },
      { id: 'canvas:2', title: 'Midterm 1', score: 82, points: 100 },
      { id: 'canvas:3', title: 'Final Exam', score: 70, points: 100 },
    ], () => `n${n++}`)
    expect(filled).toBe(3)
    expect(grading.categories.map(c => c.items.map(i => [i.name, i.got, i.canvasId]))).toEqual([[['HW 1', 9, 'canvas:1']], [['Midterm 1', 82, 'canvas:2']], [['Final Exam', 70, 'canvas:3']]])
    expect(withCanvasScores(grading, [{ id: 'canvas:1', title: 'HW 1', score: 9, points: 10 }], () => 'x').filled).toBe(0)
    expect(categoryFor(g, 'Quiz 3')?.name).toBe('Homework')
  })
})
