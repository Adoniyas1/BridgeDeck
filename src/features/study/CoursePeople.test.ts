import { describe, expect, it } from 'vitest'
import { peopleOf, validEmail } from './CoursePeople'

describe('course people', () => {
  it('reads saved contacts, ignoring junk', () => {
    expect(peopleOf({ people: [{ role: 'Professor', name: ' Dr. Lee ', email: 'lee@csulb.edu', hours: 'Tu 2-4' }, { role: 'TA' }, 5] })).toEqual([{ role: 'Professor', name: 'Dr. Lee', email: 'lee@csulb.edu', hours: 'Tu 2-4' }])
    expect(peopleOf({})).toEqual([])
  })
  it('only emails plain addresses', () => {
    expect(validEmail('lee@csulb.edu')).toBe(true)
    expect(validEmail('lee@csulb.edu?bcc=x@y.z')).toBe(false)
    expect(validEmail('a b@c.d')).toBe(false)
    expect(validEmail('nope')).toBe(false)
  })
})
