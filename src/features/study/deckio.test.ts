import { describe, expect, it } from 'vitest'
import type { Note } from '../../lib/bridge'
import { deckOf } from './cards'
import { importLines, parseDelimited, toCsv } from './deckio'

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
