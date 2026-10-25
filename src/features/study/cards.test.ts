import { describe, expect, it } from 'vitest'
import { Rating, State } from 'ts-fsrs'
import type { Note } from '../../lib/bridge'
import { inline } from '../notes/model'
import { allDue, cardBody, cardLine, coversChapter, masteryMap, deckOf, deckStats, dueCards, hasMark, makeCloze, setMark, withBody, parseCard, parseCards, span, withState } from './cards'
import vectors from './card-vectors.json'
import { intervals, review } from './review'
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

describe('card grammar (shared with Rust)', () => {
  it('reads every example the same way', () => {
    for (const v of vectors as Array<{ text: string; cards: Array<{ sub: string; front: string; back: string; due: number | null }> }>) {
      const got = parseCards(v.text).map(c => ({ sub: c.sub, front: c.front, back: c.back, due: c.card.due.getTime() || null }))
      expect(got, v.text).toEqual(v.cards)
    }
  })
  it('saves one sub-card without touching the others', () => {
    const line = 'Anode ::: positive electrode <!--fsrs b: due=7 s=2-->'
    const [f] = parseCards(line)
    const saved = withState(line, { ...f.card, due: new Date(11), stability: 3, state: State.Review }, 'f')
    expect(saved).toMatch(/<!--fsrs b: due=7 s=2 \| f: due=11 s=3 /)
    expect(parseCards(saved).map(c => c.card.due.getTime())).toEqual([11, 7])
    // A one-card line keeps the old form, which older builds read.
    expect(withState('a :: b', f.card)).toMatch(/^a :: b <!--fsrs due=0 /)
  })
  it('makes cloze deletions', () => {
    expect(makeCloze('The anode is positive', 'anode')).toBe('The {{c1::anode}} is positive')
    expect(makeCloze('The {{c1::anode}} is positive', 'positive')).toBe('The {{c1::anode}} is {{c2::positive}}')
    expect(makeCloze('x', 'y')).toBe('x')
  })
})

describe('editing card lines', () => {
  it('keeps the review state and handles marks', () => {
    const line = 'Q :: A <!--fsrs due=5 s=1-->'
    expect(withBody(line, 'Q2 :: A2')).toBe('Q2 :: A2 <!--fsrs due=5 s=1-->')
    const put = setMark(line, 'suspended', true)
    expect(put).toBe('Q :: A #suspended <!--fsrs due=5 s=1-->')
    expect(hasMark(put, 'suspended')).toBe(true)
    expect(parseCards(put)[0].back).toBe('A')
    expect(setMark(put, 'suspended', false)).toBe(line)
    expect(cardBody(put)).toBe('Q :: A #suspended')
  })
})

describe('mixed review', () => {
  it('takes cards from each course in turn', () => {
    const n = (id: string, folder: string, lines: string[]): Note => ({ id, title: 'flashcards', folder, pinned: false, kind: 'note', created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, seq: 0,
      blocks: lines.map((text, i) => ({ id: `${id}${i}`, kind: 'p', text, checked: false, due: null, pos: String(i), updated: 0, by: '', deleted: false })) })
    const notes = [n('a', 'Study/EE 310', ['a1 :: x', 'a2 :: x', 'a3 :: x']), n('b', 'Study/MATH 370', ['b1 :: y'])]
    expect(allDue(notes, ['EE 310', 'MATH 370']).map(c => c.front)).toEqual(['a1', 'b1', 'a2', 'a3'])
  })
})

describe('mastery map', () => {
  it('groups cards by the chapter their page is in', () => {
    const card = (front: string, page: number, state: number) => ({ id: front, noteId: 'n', sub: '', block: {} as Note['blocks'][number], front, back: `x ([Circuits, p. ${page}](book:EE/circuits.pdf#${page}))`,
      card: { due: new Date(0), stability: 1, difficulty: 1, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 1, lapses: 0, state: state as State, last_review: undefined } })
    const deck = [card('a', 5, 2), card('b', 40, 2), card('c', 45, 0), { ...card('d', 1, 2), back: 'plain' }]
    const map = masteryMap(deck, file => file === 'circuits.pdf' ? [{ title: '1 Basics', page: 1 }, { title: '2 Nodes', page: 30 }] : [], () => 0.9)
    expect(map.map(m => [m.label, m.cards, m.learned, Number(m.recall.toFixed(2))])).toEqual([['Circuits: 1 Basics', 1, 1, 0.9], ['Circuits: 2 Nodes', 2, 1, 0.45], ['Other cards', 1, 1, 0.9]])
  })
})

describe('exam scope', () => {
  it('matches chapters by number range and by words', () => {
    expect(coversChapter('Circuits: 3 Nodal analysis', 'Ch 3-5, 7')).toBe(true)
    expect(coversChapter('Circuits: Chapter 6 Op amps', 'Ch 3-5, 7')).toBe(false)
    expect(coversChapter('Circuits: 7 First-order circuits', 'chapters 3 to 5 and 7')).toBe(true)
    expect(coversChapter('Signals: Fourier series', 'Fourier series and transforms')).toBe(true)
    expect(coversChapter('Other cards', '')).toBe(false)
  })
})

describe('reviews sent from the phone', () => {
  it('applies a review once, and never one older than the last', async () => {
    const { isNewReview } = await import('./cards')
    const { createEmptyCard } = await import('ts-fsrs')
    const card = createEmptyCard(new Date(0))
    expect(isNewReview(card, 1000)).toBe(true)
    const reviewed = { ...card, last_review: new Date(1000) }
    expect(isNewReview(reviewed, 1000)).toBe(false)
    expect(isNewReview(reviewed, 900)).toBe(false)
    expect(isNewReview(reviewed, 1001)).toBe(true)
  })
})
