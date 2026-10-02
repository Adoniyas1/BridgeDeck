import { describe, expect, it } from 'vitest'
import { Rating, State } from 'ts-fsrs'
import type { Note } from '../../lib/bridge'
import { inline } from '../notes/model'
import { cardLine, deckOf, deckStats, dueCards, intervals, parseCard, review, span, withState } from './cards'
import { pageText } from './indexer'
import { bookLink, parseBookLink, studyMinutes, weekStart } from './model'

const note = (title: string, folder: string, lines: string[]): Note => ({ id: title, title, folder, pinned: false, kind: 'note', created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, seq: 0,
  blocks: lines.map((text, i) => ({ id: `${title}${i}`, kind: 'li' as const, text, checked: false, due: null, pos: `${i}`, updated: 0, by: '', deleted: false })) })

describe('flashcards', () => {
  it('reads cards from flashcard notes in the course folder only', () => {
    const deck = deckOf([
      note('Math 221 — flashcards', 'Study/Math 221', ['What is a limit? :: The value f(x) approaches', 'Just a line', 'Chain rule? :: f\'(g(x))g\'(x) ([Calculus, p. 2](book:Math%20221/calc.pdf#2))']),
      note('Math 221 notes', 'Study/Math 221', ['Not a card? :: it is not in a flashcard note']),
      note('Biology flashcards', 'Study/Biology', ['ATP? :: Energy']),
    ], 'Math 221')
    expect(deck.map(c => c.front)).toEqual(['What is a limit?', 'Chain rule?'])
    expect(deck[0].card.state).toBe(State.New)
    expect(deckStats(deck)).toEqual({ total: 2, fresh: 2, due: 0, learned: 0 })
  })

  it('schedules with FSRS and keeps the state in the line, hidden when shown', () => {
    const now = new Date('2026-10-02T10:00:00Z')
    const line = cardLine('What is  a limit?', 'The value :: approached\n by f(x)')
    expect(line).toBe('What is a limit? :: The value : approached by f(x)')
    const first = parseCard(line)!
    const good = review(first.card, Rating.Good, now)
    expect(good.due.getTime()).toBeGreaterThan(now.getTime())
    const saved = withState(line, good)
    expect(saved).toMatch(/^What is a limit\? :: The value : approached by f\(x\) <!--fsrs due=\d+ s=[\d.]+ d=[\d.]+ sd=\d+ ls=\d+ r=1 l=0 st=\d lr=\d+-->$/)
    const again = parseCard(saved)!
    expect(again.back).toBe('The value : approached by f(x)')
    expect(again.card.due.getTime()).toBe(good.due.getTime())
    expect(again.card.reps).toBe(1)
    // A second review replaces the state rather than adding another.
    expect(withState(saved, review(again.card, Rating.Good, good.due)).match(/<!--fsrs/g)).toHaveLength(1)
    // Notes and Obsidian show the card without the state.
    expect(inline(saved).map(p => p.text).join('')).toBe('What is a limit? :: The value : approached by f(x)')
    const shown = intervals(first.card, now)
    expect(shown[Rating.Again]).toMatch(/m$/)
    expect(span(3 * 86_400_000)).toBe('3d')
  })

  it('reviews due cards first, then a limited number of new ones', () => {
    const now = Date.parse('2026-10-02T10:00:00Z')
    const learned = review(parseCard('a :: b')!.card, Rating.Good, new Date(now - 30 * 86_400_000))
    const lines = [withState('Old :: due', learned), 'New 1 :: x', 'New 2 :: y']
    const queue = dueCards(deckOf([note('C — flashcards', 'Study/C', lines)], 'C'), now, 1)
    expect(queue.map(c => c.front)).toEqual(['Old', 'New 1'])
  })
})

describe('study search and progress', () => {
  it('takes page text from pdf.js items', () => {
    expect(pageText([{ str: 'The chain', hasEOL: false }, { str: 'rule', hasEOL: true }, { str: 'states  that', hasEOL: false }, {}])).toBe('The chain rule\nstates that')
  })

  it('makes book links that survive parentheses inside a Markdown link', () => {
    const link = bookLink('Math 221', 'Calculus (8th ed).pdf', 4)
    expect(link).toBe('book:Math%20221/Calculus%20%288th%20ed%29.pdf#4')
    expect(parseBookLink(link)?.file).toBe('Calculus (8th ed).pdf')
    expect(inline(`[Calculus, p. 4](${link})`)).toEqual([{ kind: 'link', text: 'Calculus, p. 4', href: link }])
  })

  it('adds up focus sessions from the calendar', () => {
    const ev = (title: string, start: number, minutes: number) => ({ id: title + start, title, start, end: start + minutes * 60_000, deleted: false } as never)
    const t = Date.parse('2026-10-02T10:00:00Z')
    expect(studyMinutes([ev('Studied Math 221', t, 25), ev('Studied Math 221', t + 3_600_000, 50), ev('Studied Physics', t, 25), ev('Math 221 exam', t, 120)], 'Math 221', t - 1, t + 86_400_000)).toBe(75)
    const monday = new Date(weekStart(Date.parse('2026-10-04T12:00:00')))
    expect([monday.getDay(), monday.getHours(), monday.getDate()]).toEqual([1, 0, 28])
  })
})
