import { describe, expect, it } from 'vitest'
import { best, looksLikeUrl, score } from './search'

describe('search everything', () => {
  it('ranks title starts over words over parts over details', () => {
    expect(score('cal', 'Calendar')).toBeGreaterThan(score('cal', 'My calendar'))
    expect(score('cal', 'My calendar')).toBeGreaterThan(score('cal', 'Local'))
    expect(score('cal', 'Local')).toBeGreaterThan(score('cal', 'Notes', 'calculus'))
    expect(score('chain rule', 'Chain rule')).toBeGreaterThan(0)
    expect(score('chain zebra', 'Chain rule')).toBe(0)
    expect(score('(x', 'f(x)')).toBeGreaterThan(0)
    expect(best(['Notes', 'Calendar', 'Local', 'My calendar'], 'cal', s => [s], 2)).toEqual(['Calendar', 'My calendar'])
  })

  it('spots web addresses', () => {
    expect(looksLikeUrl('wikipedia.org')).toBe(true)
    expect(looksLikeUrl('https://x.org/a?b')).toBe(true)
    expect(looksLikeUrl('chain rule')).toBe(false)
    expect(looksLikeUrl('notes')).toBe(false)
  })
})
