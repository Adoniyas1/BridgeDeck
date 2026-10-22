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
