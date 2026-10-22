import { describe, expect, it } from 'vitest'
import { calibration, readMistakes } from './mistakes'

describe('mistakes and predictions', () => {
  it('reads both kinds and compares predictions with scores', () => {
    const { mistakes, predictions } = readMistakes({
      'm:1': { course: 'EE', assignment: 'HW 3', text: 'Sign of the current in the loop', at: 2 },
      'm:2': { text: ' ' }, 'p:a1': { predicted: 90, course: 'EE', assignment: 'HW 3' }, 'p:a2': { predicted: 80 }, 'p:a3': { predicted: 'lots' }, x: null,
    })
    expect(mistakes.map(m => m.text)).toEqual(['Sign of the current in the loop'])
    expect(predictions.map(p => p.assignmentId)).toEqual(['a1', 'a2'])
    expect(calibration(predictions, { a1: 82, a2: null })).toEqual({ count: 1, gap: 8 })
    expect(calibration(predictions, {})).toBeNull()
  })
})

describe('hours per assignment', () => {
  it('adds up focus sessions tagged with the assignment', async () => {
    const { assignmentHours, assignmentTag } = await import('./model')
    const ev = (notes: string, hours: number, deleted = false) => ({ id: notes, title: 'Studied EE', start: 0, end: hours * 3_600_000, allDay: false, location: '', notes, color: '', repeat: null, skip: [], reminder: null, updated: 0, by: '', deleted, seq: 0 })
    expect(assignmentHours([ev(`For: HW ${assignmentTag('a1')}`, 1.5), ev(`x ${assignmentTag('a1')}`, 1, true), ev(`For ${assignmentTag('a2')}`, 2)], 'a1')).toBe(1.5)
  })
})
