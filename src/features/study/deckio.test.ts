import { describe, expect, it } from 'vitest'
import type { Note } from '../../lib/bridge'
import { createEmptyCard, fsrs, type Card, type Grade } from 'ts-fsrs'
import { deckOf, parseCards, type FlashCard } from './cards'
import { ankiLines, ankiText, importLines, parseDelimited, toCsv, type AnkiDeck } from './deckio'

const note = (lines: string[]): Note => ({ id: 'n', title: 'EE — flashcards', folder: 'Study/EE', pinned: false, kind: 'note', created: 0, titleUpdated: 0, metaUpdated: 0, deleted: false, seq: 0,
  blocks: lines.map((text, i) => ({ id: `b${i}`, kind: 'p', text, checked: false, due: null, pos: String(i), updated: 0, by: '', deleted: false })) })

describe('card import and export', () => {
  it('round-trips every kind of card with its progress', () => {
    const deck = deckOf([note(['Ohm, again :: V = "IR" <!--fsrs due=5 s=1-->', 'Anode ::: positive', 'The {{c1::cathode}} is negative'])], 'EE')
    const csv = toCsv(deck)
    expect(csv.split('\r\n')[1]).toBe('qa,"Ohm, again","V = ""IR""",<!--fsrs due=5 s=1-->')
    const back = importLines(csv)
    expect(back).toEqual({ lines: ['Ohm, again :: V = "IR" <!--fsrs due=5 s=1-->', 'Anode ::: positive', 'The {{c1::cathode}} is negative'], skipped: 0, duplicates: 0 })
    expect(importLines(csv, deck)).toMatchObject({ lines: [], duplicates: 3 })
  })
  it('reads term lists from Quizlet and spreadsheets', () => {
    expect(importLines('Capacitor\tStores charge\nInductor\tStores energy in a field\n\nlonely\n')).toEqual({ lines: ['Capacitor :: Stores charge', 'Inductor :: Stores energy in a field'], skipped: 1, duplicates: 0 })
    expect(parseDelimited('a,"b\nc",d\r\ne,f')).toEqual([['a', 'b\nc', 'd'], ['e', 'f']])
  })
})

describe('Anki decks', () => {
  const scheduler = fsrs({ enable_fuzz: false })
  const replay = (reviews: Array<{ at: number; ease: number }>) => reviews.reduce<Card>((card, r) => scheduler.next(card, new Date(r.at), r.ease as Grade).card, createEmptyCard(new Date(reviews[0].at)))
  const day = 86_400_000, t0 = Date.UTC(2026, 8, 1)
  const deck: AnkiDeck = {
    notes: [
      { fields: ['Ohm&#39;s law?<br><img src="ohm.png">', 'V = I&nbsp;R <b>always</b>'], tags: '', cards: [{ ord: 0, suspended: false, reviews: [{ at: t0, ease: 3 }, { at: t0 + 3 * day, ease: 3 }] }] },
      { fields: ['Capacitor', 'Stores charge [sound:cap.mp3]'], tags: '', cards: [{ ord: 0, suspended: false, reviews: [] }, { ord: 1, suspended: false, reviews: [{ at: t0, ease: 1 }] }] },
      { fields: ['The {{c1::anode}} is {{c2::positive::sign}}', 'Back extra'], tags: '', cards: [{ ord: 0, suspended: true, reviews: [] }, { ord: 1, suspended: true, reviews: [] }] },
      { fields: ['', ''], tags: '', cards: [{ ord: 0, suspended: false, reviews: [] }] },
      { fields: ['Capacitor', 'Stores charge'], tags: '', cards: [{ ord: 0, suspended: false, reviews: [] }, { ord: 1, suspended: false, reviews: [] }] },
    ],
    pictures: { 'ohm.png': 'ohm.png' },
    leftOut: 1,
  }

  it('turns fields into card text', () => {
    expect(ankiText('a<br/>b&amp;c &lt;x&gt; &#x3a9; <span style="x">d</span>', () => null)).toBe('a b&c <x> Ω d')
    expect(ankiText('<img src="gone.png">Q', () => null)).toBe('Q')
  })

  it('makes lines for each kind of note, with the reviews replayed', () => {
    const out = ankiLines(deck, { picture: f => `![](bdimg:EE/${f})`, replay })
    expect(out.lines).toHaveLength(3)
    expect(out.skipped).toBe(1)
    expect(out.duplicates).toBe(1)
    expect(out.reviewed).toBe(2)
    const [ohm, cap, cloze] = out.lines
    expect(ohm).toMatch(/^Ohm's law\? !\[\]\(bdimg:EE\/ohm\.png\) :: V = I R always <!--fsrs /)
    const ohmCard = parseCards(ohm)[0].card
    expect(ohmCard.reps).toBe(2)
    expect(ohmCard.due.getTime()).toBeGreaterThan(t0 + 4 * day)
    // Both ways: only the back→front card was reviewed (and forgotten).
    const [f, b] = parseCards(cap)
    expect(f.card.reps).toBe(0)
    expect(b.card.reps).toBe(1)
    expect(b.card.lapses + b.card.reps).toBeGreaterThan(0)
    expect(cloze).toBe('The {{c1::anode}} is {{c2::positive::sign}} #suspended')
    expect(parseCards(cloze).map(c => c.sub)).toEqual(['c1', 'c2'])
  })

  it('leaves out what the course already has', () => {
    const existing = parseCards('Capacitor ::: Stores charge').length ? [{ id: 'x', noteId: 'n', block: { id: 'b', kind: 'p', text: 'Capacitor ::: Stores charge', checked: false, due: null, pos: 'a', updated: 0, by: '', deleted: false }, sub: 'f', front: 'Capacitor', back: 'Stores charge', card: createEmptyCard() }] as unknown as FlashCard[] : []
    expect(ankiLines(deck, { existing, picture: f => f, replay }).duplicates).toBe(2)
  })
})
