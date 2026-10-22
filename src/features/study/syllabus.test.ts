import { describe, expect, it } from 'vitest'
import type { CourseInfo } from '../../lib/bridge'
import { applySyllabus, readSyllabus } from './syllabus'

describe('syllabus suggestions', () => {
  it('merges weights, people and AI policy, and lists what changes', () => {
    const info = { code: '', title: '', canvasId: '', canvasCode: '', grading: { categories: [{ id: 'h', name: 'Homework', weight: 20, items: [{ id: 'i', name: 'HW1', got: 9, max: 10 }] }] }, people: [{ role: 'Professor', name: 'Dr. Ada', email: 'ada@csulb.edu', hours: '' }] } as CourseInfo
    const s = readSyllabus({
      weights: [{ name: 'homework', weight: 25 }, { name: 'Final', weight: 40 }, { name: 'bad', weight: 900 }],
      people: [{ role: 'Professor', name: 'Dr. Ada', email: 'ADA@csulb.edu', hours: 'MW 2-3 pm, ECS 501' }, { role: 'TA', name: 'Sam', email: 'sam@csulb.edu', hours: 'F 10-11' }],
      aiPolicy: 'none',
      exams: [{ title: 'Midterm', start: new Date(2026, 9, 20, 10).getTime(), room: 'ECS 302' }, { title: 'x', start: 'soon' }],
    })
    expect(s.weights).toHaveLength(2)
    expect(s.exams).toHaveLength(1)
    const { patch, changes } = applySyllabus(info, s)
    expect((patch.grading as { categories: Array<{ name: string; weight: number; items: unknown[] }> }).categories.map(c => [c.name, c.weight, c.items.length])).toEqual([['Homework', 25, 1], ['Final', 40, 0]])
    expect((patch.people as Array<{ name: string; hours: string }>).map(p => [p.name, p.hours])).toEqual([['Dr. Ada', 'MW 2-3 pm, ECS 501'], ['Sam', 'F 10-11']])
    expect(patch.aiPolicy).toBe('none')
    expect(changes.slice(0, 2)).toEqual(['Homework: 20% → 25%', 'New grade category Final (40%)'])
    expect(changes.some(c => c.startsWith('Exam: Midterm'))).toBe(true)
  })
})
