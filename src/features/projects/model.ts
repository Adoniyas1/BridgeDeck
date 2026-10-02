import type { CalEvent, Note, NoteBlock, NotePatch } from '../../lib/bridge'
import { between, newId, visible } from '../notes/model'

/** A project's notes live in this Notes folder. */
export const projectFolder = (project: string) => `Projects/${project}`
export const boardTitle = (project: string) => `${project} — board`
export const BOARD_COLUMNS = ['To do', 'Doing', 'Done']
export const BOARD_MARKDOWN = BOARD_COLUMNS.map(c => `## ${c}`).join('\n\n')

/** Cards in a column whose name says it's finished are ticked (same rule as notes.rs). */
export const isDoneColumn = (name: string) => /done|complete|finished|shipped/i.test(name)

export type BoardCard = { block: NoteBlock; subs: NoteBlock[] }
export type BoardColumn = { heading: NoteBlock | null; title: string; cards: BoardCard[] }

/** The board's columns: each heading with the checklist items under it, sub-tasks with their card. */
export function boardColumns(note: Note): BoardColumn[] {
  const columns: BoardColumn[] = []
  for (const block of visible(note)) {
    if (block.kind === 'h1' || block.kind === 'h2' || block.kind === 'h3') columns.push({ heading: block, title: block.text.trim() || 'Untitled', cards: [] })
    else if (block.kind === 'todo') {
      if (!columns.length) columns.push({ heading: null, title: BOARD_COLUMNS[0], cards: [] })
      const column = columns[columns.length - 1]
      if ((block.indent ?? 0) > 0 && column.cards.length) column.cards[column.cards.length - 1].subs.push(block)
      else column.cards.push({ block, subs: [] })
    }
  }
  return columns
}

const lastPos = (card: BoardCard) => card.subs.length ? card.subs[card.subs.length - 1].pos : card.block.pos

/** Positions for `count` blocks placed right after the column's `index`-th card (-1: at the top). */
function slot(note: Note, columns: BoardColumn[], column: number, index: number, count: number, moving: Set<string>) {
  const cards = columns[column].cards.filter(c => !moving.has(c.block.id))
  const before = index >= 0 && cards[Math.min(index, cards.length - 1)] ? lastPos(cards[Math.min(index, cards.length - 1)]) : columns[column].heading?.pos ?? ''
  const all = visible(note).filter(b => !moving.has(b.id))
  const after = all.find(b => b.pos > before)?.pos ?? ''
  const out: string[] = []
  let a = before
  for (let i = 0; i < count; i++) { a = between(a, after); out.push(a) }
  return out
}

/** Moves a card (and its sub-tasks) into a column, after the card at `index` (-1: first). */
export function moveCard(note: Note, cardId: string, column: number, index: number): NotePatch | null {
  const columns = boardColumns(note)
  const card = columns.flatMap(c => c.cards).find(c => c.block.id === cardId)
  if (!card || !columns[column]) return null
  const blocks = [card.block, ...card.subs]
  const positions = slot(note, columns, column, index, blocks.length, new Set(blocks.map(b => b.id)))
  const done = isDoneColumn(columns[column].title)
  return { id: note.id, blocks: blocks.map((b, i) => ({ ...b, pos: positions[i], checked: i === 0 || done ? done : b.checked })) }
}

/** A new card at the end of a column. */
export function addCard(note: Note, column: number, text: string): NotePatch | null {
  const columns = boardColumns(note)
  if (!columns[column] || !text.trim()) return null
  const [pos] = slot(note, columns, column, columns[column].cards.length - 1, 1, new Set())
  return { id: note.id, blocks: [{ id: newId(), kind: 'todo', text: text.replace(/\s+/g, ' ').trim(), checked: isDoneColumn(columns[column].title), due: null, pos, updated: 0, by: '', deleted: false }] }
}

/** Ticking a card moves it to the done column (and unticking it back to the first). */
export function tickCard(note: Note, cardId: string, checked: boolean): NotePatch | null {
  const columns = boardColumns(note)
  const target = checked ? columns.findIndex(c => isDoneColumn(c.title)) : 0
  if (target < 0) {
    const card = columns.flatMap(c => c.cards).find(c => c.block.id === cardId)
    return card ? { id: note.id, blocks: [{ ...card.block, checked }] } : null
  }
  return moveCard(note, cardId, target, columns[target].cards.length - 1)
}

/** Upcoming calendar events for a project (its name in the title): its milestones. */
export function projectEvents(events: CalEvent[], project: string, now = Date.now()) {
  const name = project.toLowerCase()
  return events.filter(e => !e.deleted && e.title.toLowerCase().includes(name) && (e.repeat || e.end >= now)).sort((a, b) => a.start - b.start)
}

/** "in 3 days", "today", "2 days ago". */
export function countdown(ms: number, now = Date.now()) {
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
  const days = Math.round((day(ms) - day(now)) / 86_400_000)
  return days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 0 ? `in ${days} days` : `${-days} day${days === -1 ? '' : 's'} ago`
}

/** The board's progress: cards done of all cards. */
export function boardProgress(note: Note | undefined) {
  if (!note) return { done: 0, total: 0 }
  const cards = boardColumns(note).flatMap(c => c.cards)
  return { done: cards.filter(c => c.block.checked).length, total: cards.length }
}
