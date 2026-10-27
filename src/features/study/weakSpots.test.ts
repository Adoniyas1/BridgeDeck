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

describe('pre-exam pack', () => {
  const spots = weakSpots({
    mastery: [
      { label: 'Book: Chapter 2 Networks', cards: 8, learned: 3, recall: 0.4 },
      { label: 'Book: Chapter 7 Filters', cards: 8, learned: 3, recall: 0.3 },
    ],
    lectures: [{ file: 'Lecture 4.webm', modified: 1, sidecar: { segments, markers: [{ t: 65 }] } }],
    ratings: [
      { id: 'a', rating: 'stuck', course: 'EE', assignment: 'HW 2', section: '2.1', number: '4', at: 2 },
      { id: 'b', rating: 'stuck', course: 'EE', assignment: 'HW 7', section: '7.3', number: '1', at: 1 },
    ],
    mistakes: [{ id: 'm:1', course: 'EE', assignment: 'Quiz 1', text: 'Sign of the current', at: 1 }],
  })

  it('keeps what the exam covers', async () => {
    const { forExam } = await import('./weakSpots')
    const scoped = forExam(spots, 'Ch 1-3')
    expect(scoped.filter(s => s.kind === 'chapter').map(s => s.kind === 'chapter' && s.label)).toEqual(['Book: Chapter 2 Networks'])
    expect(scoped.filter(s => s.kind === 'problem').map(s => s.kind === 'problem' && s.section)).toEqual(['2.1'])
    expect(scoped.some(s => s.kind === 'lecture') && scoped.some(s => s.kind === 'mistake')).toBe(true)
    expect(forExam(spots, '')).toEqual(spots)
  })

  it('writes one checklist with links', async () => {
    const { examPackMarkdown, forExam } = await import('./weakSpots')
    const start = new Date(2026, 10, 3, 9).getTime()
    const md = examPackMarkdown('EE 310', { title: 'Midterm 1', start, end: start + 90 * 60_000, room: 'B204', allowed: 'calculator, 1 formula sheet', covers: 'Ch 1-3' }, forExam(spots, 'Ch 1-3'), () => 'book:EE%20310/b.pdf#30', 2)
    expect(md).toContain('## Midterm 1')
    expect(md).toContain('90 minutes')
    expect(md).toContain('](book:EE%20310/b.pdf#30)')
    expect(md).toContain('](lecture:EE%20310/Lecture%204.webm#t=45)')
    expect(md).toContain('- [ ] calculator')
    expect(md).toContain('2 cards you keep forgetting')
    expect(md).not.toContain('Filters')
    expect(md).not.toMatch(/\n{3}/)
  })
})
