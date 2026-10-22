import { describe, expect, it } from 'vitest'
import { answerSpec, checkAnswer, showAnswer } from './answer'

describe('typed number answers', () => {
  it('reads the spec and checks answers with units and tolerance', () => {
    const spec = answerSpec('Thevenin R: {{num:4.7k ohm ±2%}}')!
    expect(spec.tolerance).toBe(0.02)
    expect(checkAnswer(spec, '4.7kΩ').right).toBe(true)
    expect(checkAnswer(spec, '4.65k').right).toBe(true)
    expect(checkAnswer(spec, '4.5k ohm')).toMatchObject({ right: false, grade: 1 })
    expect(checkAnswer(spec, '4.7 V').message).toBe('That’s in V; the answer is in Ω')
    expect(checkAnswer(spec, '4.7k +').right).toBe(false)
    expect(showAnswer('R = {{num:4.7k ohm ±2%}}')).toBe('R = 4.7 kΩ')
    expect(answerSpec('plain answer')).toBeNull()
  })
  it('handles complex answers', () => {
    const spec = answerSpec('{{num:10∠-30° V}}')!
    expect(checkAnswer(spec, '(8.66 - 5j) V').right).toBe(true)
    expect(checkAnswer(spec, '8.66-5j').right).toBe(true)
    expect(checkAnswer(spec, '10∠30°').right).toBe(false)
  })
})
