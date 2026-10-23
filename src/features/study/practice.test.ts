import { describe, expect, it } from 'vitest'
import { isOldExam, practiceProblems, shuffled } from './practice'

describe('practice exams', () => {
  it('picks problems from the chapters covered, hard ones first', () => {
    const assignments = [{ title: 'HW 4: Ch 3.1: 1, 2; Ch 3.2: 5' }, { title: 'HW 5: Ch 6.1: 7, 9' }]
    const ratings = [{ id: 'x', rating: 'stuck' as const, course: 'EE', assignment: 'HW 4', section: '3.2', number: '5', at: 1 }]
    const list = practiceProblems(assignments, ratings, 'Ch 3', 10, 42)
    expect(list.sort()).toEqual(['Section 3.1, problem 1', 'Section 3.1, problem 2', 'Section 3.2, problem 5'])
    expect(practiceProblems(assignments, [], '', 2, 1)).toHaveLength(2)
    expect(shuffled([1, 2, 3, 4], 7)).toEqual(shuffled([1, 2, 3, 4], 7))
  })
  it('knows old exams from the rest', () => {
    const b = (title: string) => ({ file: `${title}.pdf`, title, kind: 'pdf' as const, bytes: 1, indexed: true })
    expect([b('Midterm 1 Fall 2024'), b('Stewart Calculus'), b('Practice exam Midterm 2')].map(isOldExam)).toEqual([true, false, false])
  })
})
