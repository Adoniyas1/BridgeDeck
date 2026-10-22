import { describe, expect, it } from 'vitest'
import { newestPlace } from './reading'

describe('reading place', () => {
  it('opens where the book was left last, on either computer', () => {
    expect(newestPlace({ page: 10, at: 5 }, { page: 40, at: 9 })).toEqual({ page: 40, at: 9 })
    expect(newestPlace({ page: 10, at: 9 }, { page: 40, at: 5 })).toEqual({ page: 10, at: 9 })
    expect(newestPlace(null, { cfi: 'x', at: 1 })).toEqual({ cfi: 'x', at: 1 })
    expect(newestPlace({ page: 3, at: 0 }, null)).toEqual({ page: 3, at: 0 })
    expect(newestPlace(null, null)).toBeNull()
  })
})
