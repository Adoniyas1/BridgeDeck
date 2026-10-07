import { describe, expect, it } from 'vitest'
import { HIDDEN_SLOWDOWN, nextDelay } from './refresh'

describe('periodic refresh', () => {
  it('slows down while the window is hidden, unless asked not to', () => {
    expect(nextDelay(3000, false, 'slow')).toBe(3000)
    expect(nextDelay(3000, true, 'slow')).toBe(3000 * HIDDEN_SLOWDOWN)
    expect(nextDelay(60_000, true, 'same')).toBe(60_000)
  })
})
