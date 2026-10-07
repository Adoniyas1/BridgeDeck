import { describe, expect, it } from 'vitest'
import { expandProblems, readProblems } from './problems'

const keys = (text: string) => expandProblems(text).map(p => p.key)

describe('homework problems', () => {
  it('expands sections, ranges and odd/even', () => {
    expect(keys('M 1 · Ch 10.1: 3, 7-15 (odd), 18; Ch 10.2: 2, 5')).toEqual(['10.1#3', '10.1#7', '10.1#9', '10.1#11', '10.1#13', '10.1#15', '10.1#18', '10.2#2', '10.2#5'])
    expect(keys('Ch10.9=3,7,9,11,13a,15,17')).toEqual(['10.9#3', '10.9#7', '10.9#9', '10.9#11', '10.9#13a', '10.9#15', '10.9#17'])
    expect(keys('Ch 13.5: 1a-7a (odd)')).toEqual(['13.5#1a', '13.5#3a', '13.5#5a', '13.5#7a'])
    expect(keys('Ch 11.7: 1-5 (even), 13, 15 (just use calculator), 39')).toEqual(['11.7#2', '11.7#4', '11.7#13', '11.7#15', '11.7#39'])
    expect(keys('Ch 12.5: 3, 37?, 41')).toEqual(['12.5#3', '12.5#41'])
  })
  it('handles lists without sections, and plain assignments', () => {
    expect(keys('Problem set: 1-4, 9')).toEqual(['#1', '#2', '#3', '#4', '#9'])
    expect(keys('Lab report')).toEqual([])
    expect(keys('Read chapter 4')).toEqual([])
  })
  it('reads saved ticks', () => {
    expect(readProblems('{"a":["10.1#3",4],"b":"x"}')).toEqual({ a: ['10.1#3'] })
    expect(readProblems('nope')).toEqual({})
  })
})
