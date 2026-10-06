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
  return rest.map(b => b.kind === 'drawing' ? '✎ Drawing' : b.text.trim()).join(' · ').slice(0, 120)
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

export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code' | 'strike' | 'link' | 'wikilink' | 'tag' | 'math'; text: string; href?: string; target?: string }

/** **bold**, *italic*, `code`, ~~struck~~, links, [[note links]], #tags and $math$, for showing a
 *  block that isn't being edited. Returns plain pieces (never HTML), so nothing in a note can run. */
export function inline(raw: string): Inline[] {
  // HTML comments (such as a flashcard's review state) are kept in the note but not shown.
  const text = raw.replace(/\s*<!--[\s\S]*?-->/g, '')
  const pattern = /\[\[(?<wiki>[^\]|\n]+)(?:\|(?<alias>[^\]\n]+))?\]\]|\$(?<math>[^\s$][^$\n]*?[^\s$\\]|[^\s$])\$(?!\d)|(?<pre>^|\s)#(?<tag>[A-Za-z][\w/-]*)|\*\*(?<bold>[^*]+)\*\*|`(?<code>[^`]+)`|~~(?<strike>[^~]+)~~|\*(?<italic>[^*\s][^*]*)\*|_(?<italic2>[^_\s][^_]*)_|\[(?<label>[^\]]+)\]\((?<href>https?:\/\/[^\s)]+|book:[^\s)]+)\)|(?<url>https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(pattern)) {
    const g = m.groups ?? {}
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    if (g.wiki !== undefined) out.push({ kind: 'wikilink', text: (g.alias ?? g.wiki).trim(), target: g.wiki.trim() })
    else if (g.math !== undefined) out.push({ kind: 'math', text: g.math })
    else if (g.tag !== undefined) {
      if (g.pre) out.push({ kind: 'text', text: g.pre })
      out.push({ kind: 'tag', text: g.tag })
    } else if (g.bold !== undefined) out.push({ kind: 'bold', text: g.bold })
    else if (g.code !== undefined) out.push({ kind: 'code', text: g.code })
    else if (g.strike !== undefined) out.push({ kind: 'strike', text: g.strike })
    else if (g.italic !== undefined) out.push({ kind: 'italic', text: g.italic })
    else if (g.italic2 !== undefined) out.push({ kind: 'italic', text: g.italic2 })
    else if (g.label !== undefined) out.push({ kind: 'link', text: g.label, href: g.href })
    else out.push({ kind: 'link', text: g.url, href: g.url })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** A block that is only display math: $$ … $$. */
export function displayMath(text: string) {
  const m = text.trim().match(/^\$\$([\s\S]+)\$\$$/)
  return m ? m[1].trim() : null
}

// ---- Links between notes, tags ----

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The note a [[link]] points at: by title (or the name shown for untitled notes). */
export function findByTitle(notes: Note[], title: string) {
  return notes.find(n => sameTitle(n.title, title)) ?? notes.find(n => sameTitle(noteTitle(n), title))
}

/** Titles this note links to. */
export function linksOf(note: Note) {
  const out = new Set<string>()
  for (const block of note.blocks) {
    if (block.deleted) continue
    for (const m of block.text.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g)) out.add(m[1].trim())
  }
  return [...out]
}

/** Notes that link to this one. */
export function backlinks(notes: Note[], note: Note) {
  const names = [note.title, noteTitle(note)].filter(t => t.trim())
  return notes.filter(n => n.id !== note.id && linksOf(n).some(l => names.some(t => sameTitle(t, l))))
}

export function tagsOf(note: Note) {
  const out = new Set<string>()
  for (const block of note.blocks) {
    if (block.deleted || block.kind === 'code') continue
    for (const m of block.text.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)) out.add(m[1].toLowerCase())
  }
  return [...out]
}

export function allTags(notes: Note[]) {
  const counts = new Map<string, number>()
  for (const note of notes) for (const tag of tagsOf(note)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** The `[[` being typed before the caret, if any: what's typed so far and where it starts. */
export function linkQuery(text: string, caret: number) {
  const before = text.slice(0, caret)
  const open = before.lastIndexOf('[[')
  if (open < 0 || before.slice(open).includes(']]') || before.slice(open).includes('\n')) return null
  return { start: open, query: before.slice(open + 2) }
}

/** Notes and the links between them, for the graph. */
export function graphOf(notes: Note[]) {
  const edges: Array<[string, string]> = []
  for (const note of notes) {
    for (const title of linksOf(note)) {
      const target = findByTitle(notes, title)
      if (target && target.id !== note.id) edges.push([note.id, target.id])
    }
  }
  return edges
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

const pad = (block: NoteBlock) => '  '.repeat(indentOf(block))

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
      case 'li': lines.push(`${pad(block)}- ${block.text}`); break
      case 'ol': lines.push(`${pad(block)}${number}. ${block.text}`); break
      case 'todo': lines.push(`${pad(block)}- [${block.checked ? 'x' : ' '}] ${block.text}${due}`); break
      case 'quote': lines.push(block.text.split('\n').map(l => `> ${l}`).join('\n')); break
      case 'code': lines.push('```', block.text, '```'); break
      case 'drawing': lines.push(`![Drawing](bridgedeck-drawing:${block.text})`, ''); break
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
    return !was || was.kind !== b.kind || was.text !== b.text || was.checked !== b.checked || indentOf(was) !== indentOf(b) || was.due !== b.due || was.pos !== b.pos
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

// ---- Sub-tasks ----

export const MAX_INDENT = 4

export function indentOf(block: NoteBlock) {
  return Math.max(0, Math.min(MAX_INDENT, block.indent ?? 0))
}

/** The blocks nested under the one at `index` (everything after it that is indented further). */
export function descendants(blocks: NoteBlock[], index: number) {
  const level = indentOf(blocks[index])
  const out: NoteBlock[] = []
  for (let i = index + 1; i < blocks.length && indentOf(blocks[i]) > level; i++) out.push(blocks[i])
  return out
}

/** The block a nested block sits under, if any. */
export function parentIndex(blocks: NoteBlock[], index: number) {
  const level = indentOf(blocks[index])
  for (let i = index - 1; i >= 0; i--) if (indentOf(blocks[i]) < level) return i
  return -1
}

/** The previous block at the same level under the same parent. */
export function previousSibling(blocks: NoteBlock[], index: number) {
  const level = indentOf(blocks[index])
  for (let i = index - 1; i >= 0; i--) {
    const at = indentOf(blocks[i])
    if (at === level) return i
    if (at < level) return -1
  }
  return -1
}

/** Ticks or unticks an item with everything under it, then updates the items above: a task is
 *  done when all its sub-tasks are. Returns the changed blocks. */
export function toggleTask(shown: NoteBlock[], id: string): NoteBlock[] {
  const blocks = shown.map(b => ({ ...b }))
  const index = blocks.findIndex(b => b.id === id)
  if (index < 0) return []
  const checked = !blocks[index].checked
  const changed = new Set<string>([id])
  blocks[index].checked = checked
  for (const child of descendants(blocks, index)) {
    if (child.kind === 'todo' && child.checked !== checked) { child.checked = checked; changed.add(child.id) }
  }
  for (let at = parentIndex(blocks, index); at >= 0; at = parentIndex(blocks, at)) {
    const parent = blocks[at]
    if (parent.kind !== 'todo') break
    const level = indentOf(parent) + 1
    const kids = descendants(blocks, at).filter(b => b.kind === 'todo' && indentOf(b) === level)
    const done = kids.length > 0 && kids.every(b => b.checked)
    if (parent.checked !== done) { parent.checked = done; changed.add(parent.id) }
  }
  return blocks.filter(b => changed.has(b.id))
}

/** "3/5" for a task with sub-tasks. */
export function subProgress(blocks: NoteBlock[], index: number) {
  const level = indentOf(blocks[index]) + 1
  const kids = descendants(blocks, index).filter(b => b.kind === 'todo' && indentOf(b) === level)
  return kids.length ? { done: kids.filter(b => b.checked).length, total: kids.length } : null
}

/** A leading label with a number: "Ch 11", "11.2 Intro", "Step 3:". */
function numbering(text: string) {
  const m = text.trim().match(/^(\D{0,24}?)(\d+(?:\.\d+)*)(?=$|[\s:.)\-])/)
  return m ? { prefix: m[1], parts: m[2].split('.').map(Number) } : null
}

/** The first sub-task's label under a numbered task: "Ch 11" → "Ch 11.1". */
export function firstSubLabel(parent: string) {
  const n = numbering(parent)
  return n ? `${n.prefix}${[...n.parts, 1].join('.')} ` : ''
}

/** The next item's label when numbered items are being typed: after "Ch 11.1" under "Ch 11" comes
 *  "Ch 11.2"; after "Step 1", "Step 2" comes "Step 3". Plain text that merely ends in a number
 *  ("Buy 2 apples") isn't counted. */
export function nextLabel(text: string, parent?: string, previous?: string) {
  const n = numbering(text)
  if (!n) return ''
  const p = parent ? numbering(parent) : null
  const s = previous ? numbering(previous) : null
  const underParent = !!p && n.prefix === p.prefix && n.parts.length === p.parts.length + 1 && p.parts.every((x, i) => x === n.parts[i])
  const follows = !!s && s.prefix === n.prefix && s.parts.length === n.parts.length && s.parts.slice(0, -1).every((x, i) => x === n.parts[i]) && s.parts[s.parts.length - 1] + 1 === n.parts[n.parts.length - 1]
  if (!underParent && !follows) return ''
  const parts = [...n.parts]
  parts[parts.length - 1]++
  return `${n.prefix}${parts.join('.')} `
}

/** Just a label, nothing typed after it ("Ch 11.3 "). */
export function labelOnly(text: string) {
  return /^\D{0,24}?\d+(?:\.\d+)*\s*$/.test(text) && numbering(text) !== null
}

/** The label after a task's own: "Ch 11" → "Ch 12 ", "11.2 Intro" → "11.3 ". */
export function bumpLabel(text: string) {
  const n = numbering(text)
  if (!n) return ''
  const parts = [...n.parts]
  parts[parts.length - 1]++
  return `${n.prefix}${parts.join('.')} `
}
