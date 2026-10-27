import { describe, expect, it } from 'vitest'
import { lectureSnippet, weakSpots, weakSpotsPrompt, weakSpotText } from './weakSpots'

const segments = [
  { start: 0, end: 10, text: 'Intro.' },
  { start: 50, end: 60, text: 'Thevenin equivalents' },
  { start: 60, end: 70, text: 'replace the network.' },
  { start: 200, end: 210, text: 'Later topic.' },
]

describe('weak spots', () => {
  it('takes the transcript around a lost moment', () => {
    expect(lectureSnippet(segments, 65)).toBe('Thevenin equivalents replace the network.')
    expect(lectureSnippet(undefined, 5)).toBe('')
    expect(lectureSnippet([{ start: 0, end: 5, text: 'x'.repeat(400) }], 2).length).toBe(240)
  })

  it('puts the weakest chapters and stuck problems first, and leaves strong chapters out', () => {
    const spots = weakSpots({
      mastery: [
        { label: 'Book: 1 Basics', cards: 10, learned: 10, recall: 0.95 },
        { label: 'Book: 2 Networks', cards: 8, learned: 3, recall: 0.4 },
        { label: 'Book: 3 AC', cards: 2, learned: 0, recall: 0.1 },
        { label: 'Other cards', cards: 9, learned: 0, recall: 0.1 },
      ],
      lectures: [{ file: 'Lecture 4.webm', modified: 1, sidecar: { segments, markers: [{ t: 65 }] } }],
      ratings: [
        { id: 'a', rating: 'help', course: 'EE', assignment: 'HW 2', section: '2.1', number: '4', at: 2 },
        { id: 'b', rating: 'stuck', course: 'EE', assignment: 'HW 3', section: '3.2', number: '7', at: 1 },
      ],
      mistakes: [{ id: 'm:1', course: 'EE', assignment: 'Quiz 1', text: 'Sign of the current', at: 1 }],
    })
    expect(spots.map(s => s.kind)).toEqual(['chapter', 'problem', 'lecture', 'problem', 'mistake'])
    expect(spots[1]).toMatchObject({ rating: 'stuck', number: '7' })
    expect(weakSpotText(spots[0])).toContain('40%')
    expect(weakSpotText(spots[2])).toContain('1:05')
    expect(weakSpotText(spots[2])).toContain('Thevenin')
    const prompt = weakSpotsPrompt('EE 310', spots, 'Midterm 1')
    expect(prompt).toContain('before Midterm 1')
    expect(prompt).toContain('Stuck on problem 3.2 #7')
  })

  it('is empty when nothing is weak', () => {
    expect(weakSpots({ mastery: [], lectures: [], ratings: [], mistakes: [] })).toEqual([])
  })
})
