import { describe, expect, it } from 'vitest'
import { expandProblems, nextRating, problemId, problemsFromState, ratingsFromState } from './problems'

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
    expect(problemsFromState({ [problemId('a', '10.1#3')]: true, [problemId('a', '4')]: true, [problemId('b', 'x')]: false, nosep: true })).toEqual({ a: ['10.1#3', '4'] })
    expect(problemsFromState({})).toEqual({})
  })
})

describe('problem ratings', () => {
  it('reads ratings, stuck ones first, and cycles them', () => {
    const list = ratingsFromState({ a: { rating: 'help', number: '3', section: '10.1', course: 'EE', assignment: 'HW', at: 2 }, b: { rating: 'stuck', number: '5', at: 1 }, c: { rating: 'meh', number: '1' }, d: null })
    expect(list.map(r => [r.id, r.rating])).toEqual([['b', 'stuck'], ['a', 'help']])
    expect([nextRating(undefined), nextRating('help'), nextRating('stuck')]).toEqual(['help', 'stuck', null])
  })
})

describe('problems as cards', () => {
  it('says what to redo and where to look', async () => {
    const { problemCardBack, problemCardFront } = await import('./problems')
    expect(problemCardFront({ assignment: 'HW 3', section: '1.4', number: '12' })).toBe('Redo 1.4 #12 from HW 3 on paper')
    expect(problemCardBack({ section: '1.4', rating: 'stuck' })).toBe("Check it against the answers; if it doesn't come, reread 1.4 (you were stuck on it)")
  })
})
