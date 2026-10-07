import { describe, expect, it } from 'vitest'
import { errorReport } from './ErrorLogCard'

describe('error report', () => {
  it('has the version, system and log', () => {
    const text = errorReport({ text: '[t] crash: panic\n', entries: 1, crashes: 1, path: '/x/errors.log' }, 'Mac OS X', new Date(Date.UTC(2026, 9, 7, 12, 30)))
    expect(text).toMatch(/^BridgeDeck \S+ error report, 2026-10-07 12:30 UTC\nSystem: Mac OS X\n1 entry, 1 crash\n\n\[t\] crash: panic$/)
    expect(errorReport({ text: '', entries: 0, crashes: 0, path: '' }, 'x')).toContain('(the log is empty)')
  })
})
