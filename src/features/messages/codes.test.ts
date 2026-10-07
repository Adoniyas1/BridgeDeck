import { describe, expect, it } from 'vitest'
import { findCode, spacedCode } from './codes'

describe('findCode', () => {
  it('finds codes in the usual texts', () => {
    expect(findCode('Your verification code is 482913')).toBe('482913')
    expect(findCode('G-123456 is your Google verification code.')).toBe('123456')
    expect(findCode('Your Uber code: 4821. Never share this code.')).toBe('4821')
    expect(findCode('123-456 is your Instagram code. Don’t share it.')).toBe('123456')
    expect(findCode('Use 774 210 to sign in to Microsoft')).toBe('774210')
    expect(findCode('Your Apple Account code is: 918273. Don’t share it with anyone. @apple.com #918273 %apple.com')).toBe('918273')
    expect(findCode('Chase: your one-time code is 55190302. Call 1-800-935-9935 if you didn’t ask.')).toBe('55190302')
    expect(findCode('Your login code: AB12CD')).toBe('AB12CD')
  })
  it('picks the code over amounts and other numbers', () => {
    expect(findCode('You spent $1250 today. Code 908172 confirms the payment.')).toBe('908172')
    expect(findCode('Your 2024 verification code is 3381')).toBe('3381')
  })
  it('ignores ordinary messages', () => {
    expect(findCode('See you at 1830 by the library')).toBeNull()
    expect(findCode('Room 4021 at 3pm?')).toBeNull()
    expect(findCode('what was the code we used for the wifi')).toBeNull()
    expect(findCode('')).toBeNull()
    expect(findCode(null)).toBeNull()
  })
  it('spaces long codes for reading', () => {
    expect(spacedCode('482913')).toBe('482 913')
    expect(spacedCode('4821')).toBe('4821')
  })
})
