import type { Note, NoteBlock, NoteBlockKind } from '../../lib/bridge'

/** Digits for block positions, in ASCII order so Rust and JavaScript sort them the same way. */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A position that sorts after `a` and before `b` (`''` means the start or the end). Keys never end
 *  in '0', so there is always room before any key. */
export function between(a: string, b: string): string {
  let out = ''
  let upper = b
  for (let i = 0; ; i++) {
    const lo = i < a.length ? DIGITS.indexOf(a[i]) : 0
    const hi = i < upper.length ? DIGITS.indexOf(upper[i]) : DIGITS.length
    if (lo === hi) { out += DIGITS[lo]; continue }
    const mid = Math.floor((lo + hi) / 2)
    if (mid > lo) return out + DIGITS[mid]
    // Adjacent digits: keep `lo` and look for room after `a` with no upper limit.
    out += DIGITS[lo]
    upper = ''
  }
}

export function newId() {
  return crypto.randomUUID()
}

/** The note's blocks as shown: deletion markers left out, in position order. */
export function visible(note: Note): NoteBlock[] {
  return note.blocks.filter(b => !b.deleted).sort((x, y) => x.pos < y.pos ? -1 : x.pos > y.pos ? 1 : x.id < y.id ? -1 : 1)
}

export function noteTitle(note: Note) {
  if (note.title.trim()) return note.title.trim()
  const first = visible(note).find(b => b.text.trim())
  return first ? first.text.trim().split('\n')[0].slice(0, 80) : note.kind === 'list' ? 'Untitled checklist' : 'Untitled note'
}

/** Text under the title in the list of notes. */
export function preview(note: Note) {
  const blocks = visible(note).filter(b => b.text.trim())
  const rest = note.title.trim() ? blocks : blocks.slice(1)
  return rest.map(b => b.text.trim()).join(' · ').slice(0, 120)
}

/** Markdown typed at the start of a paragraph that turns it into another kind of block. */
export function shortcut(text: string): { kind: NoteBlockKind; text: string; checked?: boolean } | null {
  const rules: Array<[RegExp, NoteBlockKind, boolean?]> = [
    [/^### /, 'h3'], [/^## /, 'h2'], [/^# /, 'h1'],
    [/^\[[xX]\] /, 'todo', true], [/^\[ ?\] /, 'todo'], [/^- \[[xX]\] /, 'todo', true], [/^- \[ ?\] /, 'todo'],
    [/^[-*] /, 'li'], [/^1[.)] /, 'ol'], [/^> /, 'quote'], [/^```$/, 'code'],
  ]
  for (const [pattern, kind, checked] of rules) {
    const match = text.match(pattern)
    if (match) return { kind, text: text.slice(match[0].length), ...(checked ? { checked } : {}) }
  }
  return null
}

/** The kind of block Enter makes after this one: lists continue, everything else is a paragraph. */
export function nextKind(kind: NoteBlockKind): NoteBlockKind {
  return kind === 'li' || kind === 'ol' || kind === 'todo' ? kind : 'p'
}

export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code' | 'strike' | 'link'; text: string; href?: string }

/** **bold**, *italic*, `code`, ~~struck~~ and links, for showing a block that isn't being edited.
 *  Returns plain pieces (never HTML), so nothing in a note can run. */
export function inline(text: string): Inline[] {
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|~~([^~]+)~~|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]))/g
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[2] !== undefined) out.push({ kind: 'bold', text: m[2] })
    else if (m[3] !== undefined) out.push({ kind: 'code', text: m[3] })
    else if (m[4] !== undefined) out.push({ kind: 'strike', text: m[4] })
    else if (m[5] !== undefined) out.push({ kind: 'italic', text: m[5] })
    else if (m[6] !== undefined) out.push({ kind: 'italic', text: m[6] })
    else if (m[7] !== undefined) out.push({ kind: 'link', text: m[7], href: m[8] })
    else out.push({ kind: 'link', text: m[9], href: m[9] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

export function formatDue(due: number, now = Date.now()) {
  const date = new Date(due)
  const today = new Date(now)
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const tomorrow = new Date(now + 86_400_000)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay(date, today)) return `Today ${time}`
  if (sameDay(date, tomorrow)) return `Tomorrow ${time}`
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })} ${time}`
}

/** The note as Markdown, for copying elsewhere. */
export function toMarkdown(note: Note) {
  const lines: string[] = []
  if (note.title.trim()) lines.push(`# ${note.title.trim()}`, '')
  let number = 0
  for (const block of visible(note)) {
    number = block.kind === 'ol' ? number + 1 : 0
    const due = block.due ? ` (due ${new Date(block.due).toLocaleString()})` : ''
    switch (block.kind) {
      case 'h1': lines.push(`# ${block.text}`); break
      case 'h2': lines.push(`## ${block.text}`); break
      case 'h3': lines.push(`### ${block.text}`); break
      case 'li': lines.push(`- ${block.text}`); break
      case 'ol': lines.push(`${number}. ${block.text}`); break
      case 'todo': lines.push(`- [${block.checked ? 'x' : ' '}] ${block.text}${due}`); break
      case 'quote': lines.push(block.text.split('\n').map(l => `> ${l}`).join('\n')); break
      case 'code': lines.push('```', block.text, '```'); break
      default: lines.push(block.text, '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function matches(note: Note, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = [note.title, note.folder, ...note.blocks.filter(b => !b.deleted).map(b => b.text)].join('\n').toLowerCase()
  return words.every(w => haystack.includes(w))
}

export function folders(notes: Note[]) {
  return [...new Set(notes.map(n => n.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

/** Pinned first, then most recently changed. */
export function sortNotes(notes: Note[]) {
  const changed = (n: Note) => Math.max(n.created, n.titleUpdated, n.metaUpdated, ...n.blocks.map(b => b.updated))
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || changed(b) - changed(a))
}

export type DueItem = { note: Note; block: NoteBlock }

/** Unchecked checklist items with a due time, soonest first. */
export function dueItems(notes: Note[]): DueItem[] {
  return notes.flatMap(note => visible(note).filter(b => b.kind === 'todo' && b.due && !b.checked).map(block => ({ note, block })))
    .sort((a, b) => (a.block.due ?? 0) - (b.block.due ?? 0))
}

/** Items that just became due and haven't been announced (marks them announced). Items more than
 *  a day overdue when BridgeDeck starts aren't announced: they'd arrive as a pile. */
export function remindersDue(notes: Note[], now: number, announced: Set<string>) {
  return dueItems(notes).filter(({ block }) => {
    const key = `${block.id}:${block.due}`
    if (announced.has(key) || (block.due ?? 0) > now) return false
    announced.add(key)
    return now - (block.due ?? 0) < 86_400_000
  })
}

/** The fields and blocks that differ between what was loaded and what's shown, for saving. */
export function diff(before: Note, after: Note) {
  const patch: import('../../lib/bridge').NotePatch = { id: after.id }
  if (before.title !== after.title) patch.title = after.title
  if (before.folder !== after.folder) patch.folder = after.folder
  if (before.pinned !== after.pinned) patch.pinned = after.pinned
  if (before.kind !== after.kind) patch.kind = after.kind
  const old = new Map(before.blocks.filter(b => !b.deleted).map(b => [b.id, b]))
  const now = new Set(after.blocks.filter(b => !b.deleted).map(b => b.id))
  const changed = after.blocks.filter(b => {
    if (b.deleted) return false
    const was = old.get(b.id)
    return !was || was.kind !== b.kind || was.text !== b.text || was.checked !== b.checked || was.due !== b.due || was.pos !== b.pos
  })
  if (changed.length) patch.blocks = changed
  const removed = [...old.keys()].filter(id => !now.has(id))
  if (removed.length) patch.removed = removed
  return Object.keys(patch).length > 1 ? patch : null
}

/** Applies a note from the store under local edits that haven't been saved yet: unsaved blocks and
 *  fields stay as typed, everything else takes the stored version. */
export function rebase(stored: Note, base: Note, draft: Note): Note {
  const pending = diff(base, draft)
  if (!pending) return stored
  const blocks = stored.blocks.filter(b => !pending.removed?.includes(b.id)).map(b => pending.blocks?.find(p => p.id === b.id) ?? b)
  for (const block of pending.blocks ?? []) if (!blocks.some(b => b.id === block.id)) blocks.push(block)
  return {
    ...stored,
    title: pending.title ?? stored.title,
    folder: pending.folder ?? stored.folder,
    pinned: pending.pinned ?? stored.pinned,
    kind: pending.kind ?? stored.kind,
    blocks,
  }
}
