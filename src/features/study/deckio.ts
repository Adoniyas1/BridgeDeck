/** Flashcards in and out as text: a CSV of our own (kind, front, back, state) that keeps review
 *  progress, and plain "term<TAB>definition" lists like Quizlet's export or a spreadsheet's. */

import type { Card } from 'ts-fsrs'
import { cardBody, cardLine, clozeLine, parseCards, setMark, withState, type FlashCard } from './cards'

const HEADER = ['kind', 'front', 'back', 'state']

/** One row per card line (a both-ways or cloze line is one row). */
export function toCsv(deck: FlashCard[]): string {
  const seen = new Set<string>()
  const rows = [HEADER]
  for (const c of deck) {
    if (seen.has(c.block.id)) continue
    seen.add(c.block.id)
    const body = cardBody(c.block.text)
    const state = c.block.text.match(/<!--fsrs [^>]*?-->/)?.[0] ?? ''
    const both = body.indexOf(' ::: '), one = body.indexOf(' :: ')
    if (both >= 0) rows.push(['both', body.slice(0, both), body.slice(both + 5), state])
    else if (one >= 0) rows.push(['qa', body.slice(0, one), body.slice(one + 4), state])
    else rows.push(['cloze', body, '', state])
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

const csvCell = (v: string) => /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v

/** Rows of a CSV or TSV (quoted cells may hold commas, quotes and new lines). */
export function parseDelimited(text: string, delimiter = text.split('\n')[0].includes('\t') ? '\t' : ','): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim()))
}

/** Card lines from imported text: our CSV (with its header), or two columns of term and meaning,
 *  or one column of cloze sentences. Lines already in the deck, and rows that aren't cards, are
 *  left out; `skipped` counts the rows that weren't cards. */
export function importLines(text: string, existing: FlashCard[] = []): { lines: string[]; skipped: number; duplicates: number } {
  const rows = parseDelimited(text.replace(/^﻿/, ''))
  const ours = rows[0] && rows[0].slice(0, 3).map(c => c.trim().toLowerCase()).join(',') === 'kind,front,back'
  const have = new Set(existing.map(c => norm(cardBody(c.block.text))))
  const lines: string[] = []
  let skipped = 0, duplicates = 0
  for (const r of ours ? rows.slice(1) : rows) {
    const [kind, front, back, state] = ours ? r.map(c => c ?? '') : r.length >= 2 ? ['qa', r[0], r[1], ''] : ['cloze', r[0], '', '']
    const line = kind === 'cloze' ? clozeLine(front ?? '') : cardLine(front ?? '', back ?? '', '', kind === 'both')
    if (!parseCards(line).length) { skipped++; continue }
    const key = norm(cardBody(line))
    if (have.has(key)) { duplicates++; continue }
    have.add(key)
    // Progress comes along only in our own format, and only when it reads as review state.
    lines.push(state && /^<!--fsrs [^>]*-->$/.test(state.trim()) ? `${line} ${state.trim()}` : line)
  }
  return { lines, skipped, duplicates }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

// ---- Anki decks (.apkg, read by anki.rs) ----

export type AnkiReview = { at: number; ease: number }
export type AnkiDeck = {
  notes: Array<{ fields: string[]; tags: string; cards: Array<{ ord: number; suspended: boolean; reviews: AnkiReview[] }> }>
  /** Anki's picture names → the files saved with the course's card pictures. */
  pictures: Record<string, string>
  leftOut: number
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }

/** A field's HTML as card text: pictures as card pictures (`picture(name)`, or dropped), line
 *  breaks as spaces, other tags gone, entities decoded, sounds left out. */
export function ankiText(html: string, picture: (name: string) => string | null): string {
  return html
    .replace(/<img\b[^>]*?src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (_, a, b, c) => { const ref = picture(a ?? b ?? c); return ref ? ` ${ref} ` : ' ' })
    .replace(/<br\s*\/?>|<\/(div|p|li|tr|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** An Anki deck as card lines for a course: a basic note as "front :: back", a reversed one both
 *  ways, a cloze note as its sentence; each card's reviews replayed (`replay`) so its schedule
 *  carries on here; notes with every card suspended stay put aside. Notes already in the deck,
 *  and ones with nothing to ask, are left out. */
export function ankiLines(deck: AnkiDeck, opts: { existing?: FlashCard[]; picture: (file: string) => string; replay: (reviews: AnkiReview[]) => Card }): { lines: string[]; duplicates: number; skipped: number; reviewed: number } {
  const have = new Set((opts.existing ?? []).map(c => norm(cardBody(c.block.text))))
  const lines: string[] = []
  let duplicates = 0, skipped = 0, reviewed = 0
  const picture = (name: string) => (deck.pictures[name] ? opts.picture(deck.pictures[name]) : null)
  for (const note of deck.notes) {
    const [front = '', back = ''] = note.fields.map(f => ankiText(f, picture))
    const cloze = /\{\{c\d+::/.test(front)
    const both = !cloze && note.cards.length > 1
    let line = cloze ? clozeLine(front) : cardLine(front, back, '', both)
    const subs = parseCards(line).map(c => c.sub)
    if (!subs.length) { skipped++; continue }
    const key = norm(cardBody(line))
    if (have.has(key)) { duplicates++; continue }
    have.add(key)
    for (const card of note.cards) {
      if (!card.reviews.length) continue
      const sub = cloze ? `c${card.ord + 1}` : both ? (card.ord === 0 ? 'f' : 'b') : ''
      if (!subs.includes(sub)) continue
      line = withState(line, opts.replay(card.reviews), sub)
      reviewed++
    }
    if (note.cards.length && note.cards.every(c => c.suspended)) line = setMark(line, 'suspended', true)
    lines.push(line)
  }
  return { lines, duplicates, skipped, reviewed }
}
