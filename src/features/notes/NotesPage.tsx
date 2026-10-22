import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { CalendarClock, CheckSquare, ChevronDown, ChevronRight, Code, LineChart, Terminal, Calculator, Copy, FilePlus, ListPlus, Folder, Heading1, Heading2, List, ListChecks, ListOrdered, Pilcrow, Sparkles, User, StickyNote, PenTool, Pin, PinOff, Quote, Search, Share2, Hash, History, Link2, Lock, Trash2, X } from 'lucide-react'
import { noteHistoryClear, notesMarkdown, noteVersionRestore, notesCreate, notesDelete, notesSave, openExternal, type Note, type NoteBlock, type NoteBlockKind } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { layoutGraph } from './graph'
import { MIMIR_MEMORY_ID, editableAsText, allTags, backlinks, between, bumpLabel, descendants, diff, displayMath, findByTitle, graphOf, linkQuery, tagsOf, firstSubLabel, folders, formatDue, indentOf, inline, labelOnly, matches, MAX_INDENT, newId, nextKind, nextLabel, noteTitle, parentIndex, preview, previousSibling, rebase, sectionOf, shortcut, type Section, subProgress, toggleTask, toMarkdown, visible } from './model'
import { notesLoadedStore, notesStore, openNoteRequest, refreshNotes } from './state'
import { openBookLink } from '../study/open'
import { DrawingBlock } from './DrawingBlock'
import { CalcView, PlotView, PythonOutput } from './CellBlocks'
import { NoteHistory } from './NoteHistory'
import { LockDialog, LockedNote } from './LockedNote'
import { lockText } from './lock'

const KINDS: Array<[NoteBlockKind, string, typeof Pilcrow]> = [
  ['p', 'Text', Pilcrow], ['h1', 'Heading', Heading1], ['h2', 'Subheading', Heading2], ['li', 'Bulleted list', List],
  ['ol', 'Numbered list', ListOrdered], ['todo', 'Checklist', CheckSquare], ['quote', 'Quote', Quote], ['code', 'Code', Code], ['drawing', 'Drawing', PenTool],
  ['graph', 'Graph', LineChart], ['python', 'Python', Terminal], ['calc', 'Calculator', Calculator],
]

/** Blocks typed like code: Enter is a new line (Shift+Enter a new block), no spell check. */
const codeLike = (kind: NoteBlockKind) => kind === 'code' || kind === 'graph' || kind === 'python' || kind === 'calc'

const SECTIONS: Array<[Section, string, typeof Pilcrow]> = [['mine', 'My notes', StickyNote], ['lists', 'Checklists', ListChecks], ['mimir', 'Mimir', Sparkles]]

/** "All", "Pinned", a folder or a tag (within a section). */
type Filter = { kind: 'all' } | { kind: 'pinned' } | { kind: 'folder'; name: string } | { kind: 'tag'; name: string }

/** What a block needs to follow links and tags. */
type Nav = { notes: Note[]; openTitle: (title: string) => void; filterTag: (tag: string) => void }
const NavContext = createContext<Nav>({ notes: [], openTitle: () => undefined, filterTag: () => undefined })

function renderMath(tex: string, displayMode: boolean) {
  // KaTeX builds its own markup from the formula and escapes text; trust stays off, so a note
  // can't add links or scripts through it.
  return katex.renderToString(tex, { throwOnError: false, displayMode, trust: false, maxExpand: 500 })
}

export default function NotesPage() {
  const notes = useStore(notesStore)
  const loaded = useStore(notesLoadedStore)
  const [query, setQuery] = useState('')
  const [section, setSectionState] = useState<Section>('mine')
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [openId, setOpenId] = useState<string | null>(null)
  const [freshId, setFreshId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const counts = useMemo(() => {
    const out: Record<Section, number> = { mine: 0, lists: 0, mimir: 0 }
    for (const n of notes) out[sectionOf(n)]++
    return out
  }, [notes])
  const inSection = useMemo(() => notes.filter(n => sectionOf(n) === section), [notes, section])
  const shown = useMemo(() => inSection.filter(n => matches(n, query) && (filter.kind === 'all' || (filter.kind === 'pinned' ? n.pinned : filter.kind === 'tag' ? tagsOf(n).includes(filter.name) : n.folder === filter.name))), [inSection, query, filter])
  const folderNames = useMemo(() => folders(inSection), [inSection])
  const allFolderNames = useMemo(() => folders(notes), [notes])
  const tags = useMemo(() => allTags(inSection).slice(0, 24), [inSection])
  /** Shows a section; with `id`, opens that note in it. */
  const showSection = useCallback((next: Section, id: string | null = null) => {
    setSectionState(next); setFilter({ kind: 'all' }); setOpenId(id)
  }, [])
  const [showGraph, setShowGraph] = useState(false)
  const open = notes.find(n => n.id === openId) ?? null

  useEffect(() => { if (!openId && shown.length) setOpenId(shown[0].id) }, [openId, shown])
  const requested = useStore(openNoteRequest)
  useEffect(() => {
    if (!requested) return
    const note = notesStore.get().find(n => n.id === requested)
    setQuery(''); showSection(note ? sectionOf(note) : 'mine', requested); openNoteRequest.set(null)
  }, [requested, showSection])

  async function create(kind: 'note' | 'list') {
    setError('')
    try {
      const target: Section = kind === 'list' ? 'lists' : 'mine'
      const note = await notesCreate(kind, target === section && filter.kind === 'folder' ? filter.name : '')
      notesStore.set(current => [note, ...current])
      setQuery('')
      if (target === section) setOpenId(note.id)
      else showSection(target, note.id)
      setFreshId(note.id)
    } catch (e) { setError(String(e)) }
  }

  /** A [[link]]: opens the note, or makes it when it doesn't exist yet (as Obsidian does). */
  async function openTitle(title: string) {
    const found = findByTitle(notesStore.get(), title)
    if (found) { setQuery(''); showSection(sectionOf(found), found.id); return }
    try {
      const created = await notesCreate('note', '')
      const named = await notesSave({ id: created.id, title: title.trim() })
      notesStore.set(current => [named, ...current])
      showSection('mine', named.id)
    } catch (e) { setError(String(e)) }
  }
  const nav: Nav = { notes, openTitle: title => void openTitle(title), filterTag: tag => { setFilter({ kind: 'tag', name: tag.toLowerCase() }); setQuery('') } }

  return <NavContext.Provider value={nav}><div className="notes-layout">
    <aside className="card notes-sidebar">
      <div className="notes-search"><Search size={14} /><input placeholder="Search notes" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="notes-icon" title="Clear" onClick={() => setQuery('')}><X size={13} /></button>}</div>
      <div className="actions notes-new">
        <button onClick={() => void create('note')}><FilePlus size={15} />Note</button>
        <button onClick={() => void create('list')}><ListChecks size={15} />Checklist</button>
      </div>
      <div className="notes-sections" role="tablist">
        {SECTIONS.map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={section === id} className={section === id ? 'active' : ''} onClick={() => showSection(id)}><Icon size={13} />{label} <small>{counts[id]}</small></button>)}
      </div>
      <div className="notes-filters">
        <button className={filter.kind === 'all' ? 'active' : ''} onClick={() => setFilter({ kind: 'all' })}>All <small>{inSection.length}</small></button>
        <button className={filter.kind === 'pinned' ? 'active' : ''} onClick={() => setFilter({ kind: 'pinned' })}><Pin size={12} />Pinned</button>
        {folderNames.map(name => <button key={name} className={filter.kind === 'folder' && filter.name === name ? 'active' : ''} onClick={() => setFilter({ kind: 'folder', name })}><Folder size={12} />{name}</button>)}
        <button onClick={() => setShowGraph(true)} title="How your notes link together"><Share2 size={12} />Graph</button>
      </div>
      {tags.length > 0 && <div className="notes-filters notes-tags">
        {tags.map(([tag, count]) => <button key={tag} className={filter.kind === 'tag' && filter.name === tag ? 'active' : ''} onClick={() => setFilter({ kind: 'tag', name: tag })}><Hash size={11} />{tag} <small>{count}</small></button>)}
      </div>}
      {error && <p className="notes-error">{error}</p>}
      <div className="notes-list">
        {shown.map(n => <button key={n.id} className={n.id === openId ? 'active' : ''} onClick={() => setOpenId(n.id)}>
          <strong>{n.pinned && <Pin size={11} />}{n.kind === 'list' && <ListChecks size={12} />}{noteTitle(n)}</strong>
          <small>{preview(n) || (n.folder ? n.folder : 'Empty')}</small>
        </button>)}
        {loaded && !shown.length && <p className="notes-empty">{query ? 'No notes match.' : section === 'mimir' ? 'Notes Mimir writes for you show up here.' : section === 'lists' ? 'No checklists yet.' : notes.length ? 'Nothing here.' : 'No notes yet. They’re kept on every paired computer.'}</p>}
      </div>
    </aside>
    {open ? <NoteEditor key={open.id} stored={open} fresh={open.id === freshId} folderNames={allFolderNames} onDeleted={() => setOpenId(null)} onMoved={note => showSection(sectionOf(note), note.id)} />
      : <section className="card notes-editor notes-blank"><p>{loaded ? 'Pick a note or make a new one.' : 'Loading notes…'}</p></section>}
    {showGraph && <GraphView notes={notes} current={openId} onOpen={id => { const note = notes.find(n => n.id === id); showSection(note ? sectionOf(note) : section, id); setShowGraph(false) }} onClose={() => setShowGraph(false)} />}
  </div></NavContext.Provider>
}

/** Notes as dots, links as lines; click a dot to open the note. */
function GraphView({ notes, current, onOpen, onClose }: { notes: Note[]; current: string | null; onOpen: (id: string) => void; onClose: () => void }) {
  const [width, height] = [900, 560]
  const edges = useMemo(() => graphOf(notes), [notes])
  const linked = useMemo(() => new Set(edges.flat()), [edges])
  const [onlyLinked, setOnlyLinked] = useState(true)
  const shownNotes = notes.filter(n => !onlyLinked || linked.has(n.id) || n.id === current)
  const places = useMemo(() => layoutGraph(shownNotes.map(n => n.id), edges, width, height), [shownNotes.map(n => n.id).join(), edges])
  const degree = (id: string) => edges.filter(([a, b]) => a === id || b === id).length
  return <div className="cal-modal-back" onClick={onClose}>
    <div className="card notes-graph" onClick={e => e.stopPropagation()}>
      <div className="cal-modal-head"><h3>Graph</h3>
        <label className="cal-check"><input type="checkbox" checked={onlyLinked} onChange={e => setOnlyLinked(e.target.checked)} />Only linked notes</label>
        <button className="cal-icon" onClick={onClose}><X size={15} /></button></div>
      {shownNotes.length ? <svg viewBox={`0 0 ${width} ${height}`} className="notes-graph-svg">
        {edges.filter(([a, b]) => places.has(a) && places.has(b)).map(([a, b], i) => <line key={i} x1={places.get(a)!.x} y1={places.get(a)!.y} x2={places.get(b)!.x} y2={places.get(b)!.y} />)}
        {shownNotes.map(n => { const p = places.get(n.id)!; const r = 5 + Math.min(8, degree(n.id) * 1.5); return <g key={n.id} className={n.id === current ? 'current' : ''} onClick={() => onOpen(n.id)}>
          <circle cx={p.x} cy={p.y} r={r} /><text x={p.x} y={p.y - r - 4}>{noteTitle(n).slice(0, 28)}</text></g> })}
      </svg> : <p className="notes-empty">No links yet. Link notes by typing [[ and a note’s name.</p>}
    </div>
  </div>
}

type Focus = { id: string; caret: number | 'end' } | null

/** Edits one note. Changes are saved half a second after typing stops, as a patch of what changed,
 *  so a change that arrives from another computer meanwhile is merged rather than undone. */
function NoteEditor({ stored, fresh, folderNames, onDeleted, onMoved }: { stored: Note; fresh: boolean; folderNames: string[]; onDeleted: () => void; onMoved: (note: Note) => void }) {
  const base = useRef(stored)
  const [draft, setDraftState] = useState(stored)
  const draftRef = useRef(stored)
  /** Tasks whose sub-tasks are folded away (on this computer only). */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [focus, setFocus] = useState<Focus>(() => fresh && stored.kind === 'list' && stored.blocks[0] ? { id: stored.blocks[0].id, caret: 0 } : null)
  const [editing, setEditing] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [history, setHistory] = useState(false)
  const [locking, setLocking] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const saving = useRef(false)
  const lastKindTarget = useRef<string | null>(null)

  const setDraft = useCallback((next: Note) => { draftRef.current = next; setDraftState(next) }, [])

  const save = useCallback(async () => {
    window.clearTimeout(timer.current)
    if (saving.current) { timer.current = window.setTimeout(() => void save(), 200); return }
    const sent = draftRef.current
    const patch = diff(base.current, sent)
    if (!patch) return
    saving.current = true
    try {
      const saved = await notesSave(patch)
      const next = rebase(saved, sent, draftRef.current)
      base.current = saved
      setDraft(next)
      notesStore.set(current => current.map(n => n.id === saved.id ? saved : n))
      setStatus('')
    } catch (e) {
      setStatus(`Not saved: ${String(e)}`)
    } finally {
      saving.current = false
    }
  }, [setDraft])

  /** Moves the note between the person's notes and Mimir's, then follows it there. */
  async function moveTo(mimir: boolean) {
    await save()
    try {
      const saved = await notesSave({ id: stored.id, mimir })
      notesStore.set(current => current.map(n => n.id === saved.id ? saved : n))
      onMoved(saved)
    } catch (e) { setStatus(`Not moved: ${String(e)}`) }
  }

  const change = useCallback((next: Note) => {
    setDraft(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void save(), 500)
  }, [save, setDraft])

  // Another computer's version arrived: keep what's typed but not saved, take the rest.
  useEffect(() => {
    if (stored === base.current || saving.current) return
    setDraft(rebase(stored, base.current, draftRef.current))
    base.current = stored
  }, [stored, setDraft])

  // Save on leaving the note or the app.
  useEffect(() => {
    const flush = () => void save()
    window.addEventListener('beforeunload', flush)
    return () => { window.removeEventListener('beforeunload', flush); void save() }
  }, [save])

  const blocks = visible(draft)

  const lockedBlock = blocks.find(b => b.kind === 'locked')

  /** Takes a saved note as the current one (after locking, unlocking or putting a version back). */
  function adopt(saved: Note) {
    base.current = saved
    setDraft(saved)
    notesStore.set(current => current.map(n => n.id === saved.id ? saved : n))
  }

  /** Encrypts the note's content and replaces it with the locked block; its earlier versions
   *  (readable) are forgotten. */
  async function lockNote(password: string) {
    await save()
    const id = draftRef.current.id
    const sealed = await lockText(await notesMarkdown(id), password)
    const current = visible(draftRef.current)
    const saved = await notesSave({ id, removed: current.map(b => b.id), blocks: [{ id: newId(), kind: 'locked', text: sealed, checked: false, due: null, pos: between('', ''), updated: 0, by: '', deleted: false }] })
    await noteHistoryClear(id).catch(() => undefined)
    adopt(saved)
  }

  /** Puts an earlier version back: what's typed is saved first, then the version replaces it. */
  async function restoreVersion(at: number) {
    await save()
    adopt(await noteVersionRestore(draftRef.current.id, at))
  }

  function updateBlock(id: string, changes: Partial<NoteBlock>) {
    change({ ...draftRef.current, blocks: draftRef.current.blocks.map(b => b.id === id ? { ...b, ...changes } : b) })
  }

  /** Several blocks changed at once (ticking with sub-tasks, moving a task with its sub-tasks). */
  function updateMany(changed: NoteBlock[]) {
    const byId = new Map(changed.map(b => [b.id, b]))
    change({ ...draftRef.current, blocks: draftRef.current.blocks.map(b => byId.get(b.id) ?? b) })
  }

  function toggle(id: string) {
    updateMany(toggleTask(visible(draftRef.current), id))
  }

  /** Moves a block in or out one level, with everything nested under it. */
  function shiftIndent(index: number, by: 1 | -1) {
    const list = visible(draftRef.current)
    const block = list[index]
    const level = indentOf(block)
    if (by > 0 && (index === 0 || level >= MAX_INDENT || level > indentOf(list[index - 1]))) return false
    if (by < 0 && level === 0) return false
    const moved = [block, ...descendants(list, index)].map(b => ({ ...b, indent: Math.max(0, Math.min(MAX_INDENT, indentOf(b) + by)) }))
    // Leaving the sub-tasks of "Ch 11" with an unwritten item makes it "Ch 12".
    if (by < 0 && block.kind === 'todo' && (!block.text.trim() || labelOnly(block.text))) {
      const parent = parentIndex(list, index)
      if (parent >= 0) moved[0].text = bumpLabel(list[parent].text) || (labelOnly(block.text) ? '' : block.text)
    }
    // A new, empty sub-task under a numbered task starts with the next number ("Ch 11" → "Ch 11.1").
    if (by > 0 && !block.text && block.kind === 'todo') {
      const shifted = list.map((b, i) => i === index ? moved[0] : b)
      const parent = parentIndex(shifted, index)
      const sibling = previousSibling(shifted, index)
      moved[0].text = sibling >= 0 ? nextLabel(shifted[sibling].text, parent >= 0 ? shifted[parent].text : undefined, (() => { const before = previousSibling(shifted, sibling); return before >= 0 ? shifted[before].text : undefined })()) || '' : parent >= 0 ? firstSubLabel(shifted[parent].text) : ''
    }
    updateMany(moved)
    setFocus({ id: block.id, caret: 'end' })
    return true
  }

  /** A new sub-task at the end of a task's sub-tasks. */
  function addSubTask(index: number) {
    const list = visible(draftRef.current)
    const block = list[index]
    const kids = descendants(list, index)
    const level = indentOf(block) + 1
    const lastKid = [...kids].reverse().find(k => indentOf(k) === level)
    const lastKidIndex = lastKid ? list.indexOf(lastKid) : -1
    const before = lastKidIndex >= 0 ? previousSibling(list, lastKidIndex) : -1
    const text = lastKid ? nextLabel(lastKid.text, block.text, before >= 0 ? list[before].text : undefined) : firstSubLabel(block.text)
    setCollapsed(current => { const next = new Set(current); next.delete(block.id); return next })
    insertAfter(kids.length ? kids[kids.length - 1].id : block.id, { kind: 'todo', indent: level, text })
  }

  function insertAfter(id: string | null, block: Partial<NoteBlock>, current = draftRef.current) {
    const list = visible(current)
    const at = id ? list.findIndex(b => b.id === id) : list.length - 1
    const pos = between(list[at]?.pos ?? '', list[at + 1]?.pos ?? '')
    const added: NoteBlock = { id: newId(), kind: 'p', text: '', checked: false, due: null, pos, updated: 0, by: '', deleted: false, ...block }
    change({ ...current, blocks: [...current.blocks, added] })
    setFocus({ id: added.id, caret: added.text.length })
    return added
  }

  function removeBlock(id: string, current = draftRef.current) {
    const left = current.blocks.filter(b => b.id !== id)
    if (!left.some(b => !b.deleted)) left.push({ id: newId(), kind: current.kind === 'list' ? 'todo' : 'p', text: '', checked: false, due: null, pos: 'i', updated: 0, by: '', deleted: false })
    change({ ...current, blocks: left })
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>, block: NoteBlock, index: number) {
    const area = event.currentTarget
    const caret = area.selectionStart
    const collapsedSelection = area.selectionStart === area.selectionEnd
    const nestable = block.kind === 'todo' || block.kind === 'li' || block.kind === 'ol'
    if (event.key === 'Tab' && nestable) {
      event.preventDefault()
      shiftIndent(index, event.shiftKey ? -1 : 1)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && block.kind === 'todo') {
      event.preventDefault()
      toggle(block.id)
    } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && (codeLike(block.kind) ? event.shiftKey : !event.shiftKey)) {
      event.preventDefault()
      // An empty sub-task moves out a level; an empty top-level item becomes plain text.
      if (!block.text.trim() && nestable && indentOf(block) > 0) { shiftIndent(index, -1); return }
      if (!block.text && block.kind !== 'p' && !codeLike(block.kind)) { updateBlock(block.id, { kind: 'p' }); return }
      const before = block.text.slice(0, caret)
      const after = block.text.slice(area.selectionEnd)
      const current = { ...draftRef.current, blocks: draftRef.current.blocks.map(b => b.id === block.id ? { ...b, text: before } : b) }
      // Numbered items continue their numbering: "Ch 11.1" → "Ch 11.2".
      const parent = parentIndex(blocks, index)
      const sibling = previousSibling(blocks, index)
      const label = nestable && !after ? nextLabel(before, parent >= 0 ? blocks[parent].text : undefined, sibling >= 0 ? blocks[sibling].text : undefined) : ''
      // After a task with (unfolded) sub-tasks, the new item goes first among them.
      const kids = descendants(blocks, index)
      const intoKids = nestable && kids.length > 0 && !collapsed.has(block.id) && !after
      insertAfter(block.id, { kind: nextKind(block.kind), text: intoKids ? firstSubLabel(before) : label || after, due: null, indent: intoKids ? indentOf(block) + 1 : indentOf(block) }, current)
    } else if (event.key === 'Backspace' && collapsedSelection && caret === 0) {
      if (nestable && indentOf(block) > 0) { event.preventDefault(); shiftIndent(index, -1); return }
      if (block.kind !== 'p') { event.preventDefault(); updateBlock(block.id, { kind: 'p' }); return }
      const previous = blocks[index - 1]
      if (!previous) return
      event.preventDefault()
      // Text never runs into a drawing, handwriting or picture (its text is where the data is):
      // an empty line goes, otherwise nothing happens.
      if (!editableAsText(previous.kind)) {
        if (!block.text) { removeBlock(block.id, draftRef.current); setFocus({ id: previous.id, caret: 0 }) }
        return
      }
      const current = { ...draftRef.current, blocks: draftRef.current.blocks.map(b => b.id === previous.id ? { ...b, text: previous.text + block.text } : b) }
      removeBlock(block.id, current)
      setFocus({ id: previous.id, caret: previous.text.length })
    } else if (event.key === 'ArrowUp' && collapsedSelection && !block.text.slice(0, caret).includes('\n') && blocks[index - 1]) {
      event.preventDefault()
      setFocus({ id: blocks[index - 1].id, caret: 'end' })
    } else if (event.key === 'ArrowDown' && collapsedSelection && !block.text.slice(caret).includes('\n') && blocks[index + 1]) {
      event.preventDefault()
      setFocus({ id: blocks[index + 1].id, caret: 0 })
    } else if (event.key === 'Escape') {
      area.blur()
    }
  }

  function onText(block: NoteBlock, text: string) {
    const typed = block.kind === 'p' ? shortcut(text) : null
    if (typed) { updateBlock(block.id, typed); setFocus({ id: block.id, caret: 0 }) } else updateBlock(block.id, { text })
  }

  function setKind(kind: NoteBlockKind) {
    const id = lastKindTarget.current ?? blocks[blocks.length - 1]?.id
    if (kind === 'drawing') {
      // A drawing is a block of its own, after the current one (its text is the drawing's id).
      insertAfter(id ?? null, { kind: 'drawing', text: newId() })
      setFocus(null)
      return
    }
    if (!id) return
    const current = blocks.find(b => b.id === id)
    // A new graph starts with an example to change.
    updateBlock(id, kind === 'graph' && !current?.text.trim() ? { kind, text: 'y = sin(x)\nx: -2pi..2pi' } : kind === 'calc' && !current?.text.trim() ? { kind, text: 'R = 4.7k ohm\nC = 10uF\nf = 1/(2pi R C)' } : { kind })
    setFocus({ id, caret: 'end' })
  }

  async function remove() {
    if (!window.confirm(`Delete “${noteTitle(draft)}” on every computer?`)) return
    window.clearTimeout(timer.current)
    try {
      await notesDelete(draft.id)
      base.current = draftRef.current
      notesStore.set(current => current.filter(n => n.id !== draft.id))
      onDeleted()
      void refreshNotes()
    } catch (e) { setStatus(String(e)) }
  }

  async function copyMarkdown() {
    try { await navigator.clipboard.writeText(toMarkdown(draft)); setStatus('Copied as Markdown') } catch (e) { setStatus(String(e)) }
  }

  const checked = blocks.filter(b => b.kind === 'todo' && b.checked)
  const todos = blocks.filter(b => b.kind === 'todo')
  // Numbered lists count per level; folded tasks hide what's nested under them.
  let counters: number[] = []
  let hideDeeperThan = Infinity

  return <section className="card notes-editor">
    {history && <NoteHistory noteId={draft.id} onRestore={restoreVersion} onClose={() => setHistory(false)} />}
    {locking && <LockDialog onLock={lockNote} onClose={() => setLocking(false)} />}
    <div className="notes-toolbar">
      <div className="notes-kinds">
        {KINDS.map(([kind, label, Icon]) => <button key={kind} className="notes-icon" title={label} onMouseDown={e => e.preventDefault()} onClick={() => setKind(kind)}><Icon size={15} /></button>)}
      </div>
      <div className="notes-meta">
        <label className="notes-folder" title="Folder"><Folder size={13} /><input list="notes-folders" placeholder="No folder" value={draft.folder} onChange={e => change({ ...draftRef.current, folder: e.target.value })} /></label>
        <datalist id="notes-folders">{folderNames.map(f => <option key={f} value={f} />)}</datalist>
        <button className="notes-icon" title={draft.mimir || stored.id === MIMIR_MEMORY_ID ? 'Mimir wrote this. Move it to your notes' : 'Move to Mimir’s notes'} disabled={stored.id === MIMIR_MEMORY_ID} onClick={() => void moveTo(!draftRef.current.mimir)}>{draft.mimir || stored.id === MIMIR_MEMORY_ID ? <User size={15} /> : <Sparkles size={15} />}</button>
        <button className="notes-icon" title={draft.pinned ? 'Unpin' : 'Pin to the top'} onClick={() => change({ ...draftRef.current, pinned: !draftRef.current.pinned })}>{draft.pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
        {!lockedBlock && <button className="notes-icon" title="Lock with a password" onClick={() => setLocking(true)}><Lock size={15} /></button>}
        {!lockedBlock && <button className="notes-icon" title="Earlier versions" onClick={() => setHistory(true)}><History size={15} /></button>}
        <button className="notes-icon" title="Copy as Markdown" onClick={() => void copyMarkdown()}><Copy size={15} /></button>
        <button className="notes-icon danger-icon" title="Delete" onClick={() => void remove()}><Trash2 size={15} /></button>
      </div>
    </div>
    <input className="notes-title" autoFocus={fresh && draft.kind !== 'list'} placeholder={draft.kind === 'list' ? 'Checklist title' : 'Title'} value={draft.title}
      onChange={e => change({ ...draftRef.current, title: e.target.value })}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); if (blocks[0]) setFocus({ id: blocks[0].id, caret: 0 }) } }} />
    {todos.length > 0 && <div className="notes-progress">
      <span>{checked.length} of {todos.length} done</span>
      {checked.length > 0 && <button className="ghost" onClick={() => change({ ...draftRef.current, blocks: draftRef.current.blocks.filter(b => !(b.kind === 'todo' && b.checked && !b.deleted)) })}>Clear done</button>}
    </div>}
    {lockedBlock ? <LockedNote note={draft} block={lockedBlock} onSaved={adopt} /> : <div className="notes-blocks">
      {blocks.map((block, index) => {
        const level = indentOf(block)
        if (level > hideDeeperThan) return null
        hideDeeperThan = collapsed.has(block.id) ? level : Infinity
        let number = 0
        if (block.kind === 'ol') { counters = counters.slice(0, level + 1); counters[level] = (counters[level] ?? 0) + 1; number = counters[level] } else if (level === 0) counters = []
        const hasKids = descendants(blocks, index).length > 0
        return <BlockRow key={block.id} block={block} number={number} sub={block.kind === 'todo' ? subProgress(blocks, index) : null}
          folded={hasKids ? collapsed.has(block.id) : null}
          onFold={() => setCollapsed(current => { const next = new Set(current); if (next.has(block.id)) next.delete(block.id); else next.add(block.id); return next })}
          onAddSub={() => addSubTask(index)} editing={editing === block.id} focus={focus?.id === block.id ? focus : null}
          onFocused={() => { setEditing(block.id); lastKindTarget.current = block.id; setFocus(null) }}
          onBlurred={() => setEditing(current => current === block.id ? null : current)}
          onText={text => onText(block, text)} onKey={e => onKey(e, block, index)}
          onCheck={() => toggle(block.id)}
          onDue={due => updateBlock(block.id, { due })}
          onEdit={() => setFocus({ id: block.id, caret: 'end' })} />
      })}
      <div className="notes-tail" onClick={() => {
        const last = blocks[blocks.length - 1]
        if (last && !last.text) setFocus({ id: last.id, caret: 0 })
        else insertAfter(last?.id ?? null, { kind: draft.kind === 'list' ? 'todo' : 'p' })
      }} />
    </div>}
    <Backlinks note={draft} />
    <p className="notes-status">{status || 'Markdown works: # heading, - list, [] checklist, > quote, ``` code, [[link]], #tag, $math$. Tab makes a sub-task, Shift+Tab moves it back. ⌘/Ctrl+Enter ticks an item.'}</p>
  </section>
}

function Backlinks({ note }: { note: Note }) {
  const { notes, openTitle } = useContext(NavContext)
  const from = useMemo(() => backlinks(notes, note), [notes, note])
  if (!from.length) return null
  return <div className="notes-backlinks"><span><Link2 size={12} />Linked from</span>
    {from.map(n => <button key={n.id} onClick={() => openTitle(noteTitle(n))}>{noteTitle(n)}</button>)}
  </div>
}

function toLocalInput(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function nextNineAm() {
  const d = new Date()
  d.setHours(d.getHours() < 9 ? 9 : 24 + 9, 0, 0, 0)
  return d.getTime()
}

function BlockRow({ block, number, sub, folded, onFold, onAddSub, editing, focus, onFocused, onBlurred, onText, onKey, onCheck, onDue, onEdit }: {
  block: NoteBlock; number: number; editing: boolean; focus: Focus
  /** Sub-tasks done of total, for a task that has them. */
  sub: { done: number; total: number } | null
  /** Whether its nested items are folded away; null when it has none. */
  folded: boolean | null
  onFold: () => void; onAddSub: () => void
  onFocused: () => void; onBlurred: () => void; onText: (text: string) => void; onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onCheck: () => void; onDue: (due: number | null) => void; onEdit: () => void
}) {
  const area = useRef<HTMLTextAreaElement>(null)
  const nav = useContext(NavContext)
  const [pickingDue, setPickingDue] = useState(false)
  const showArea = editing || focus !== null || !block.text
  // Typing [[ suggests notes to link to.
  const [suggest, setSuggest] = useState<{ start: number; query: string; index: number } | null>(null)
  const caretAfter = useRef<number | null>(null)
  const options = useMemo(() => {
    if (!suggest) return []
    const q = suggest.query.trim().toLowerCase()
    const titles = nav.notes.map(n => noteTitle(n)).filter(t => t.toLowerCase().includes(q))
    const list = [...new Set(titles)].slice(0, 6)
    return q && !list.some(t => t.toLowerCase() === q) ? [...list, `${suggest.query.trim()}`] : list
  }, [suggest, nav.notes])

  function pick(title: string) {
    const el = area.current
    if (!el || !suggest) return
    const caret = el.selectionStart
    const text = `${block.text.slice(0, suggest.start)}[[${title}]]${block.text.slice(caret)}`
    caretAfter.current = suggest.start + title.length + 4
    setSuggest(null)
    onText(text)
  }

  useLayoutEffect(() => {
    if (caretAfter.current === null || !area.current) return
    area.current.setSelectionRange(caretAfter.current, caretAfter.current)
    caretAfter.current = null
  })

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggest && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggest({ ...suggest, index: (suggest.index + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[suggest.index] ?? options[0]); return }
      if (e.key === 'Escape') { e.preventDefault(); setSuggest(null); return }
    }
    onKey(e)
  }

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  })

  useLayoutEffect(() => {
    if (!focus || !area.current) return
    const el = area.current
    el.focus()
    const at = focus.caret === 'end' ? el.value.length : Math.min(focus.caret, el.value.length)
    el.setSelectionRange(at, at)
  }, [focus])

  const placeholder = block.kind === 'todo' ? 'To do' : block.kind.startsWith('h') ? 'Heading' : block.kind === 'code' ? 'Code' : block.kind === 'python' ? 'Python, e.g. print(2 ** 10)' : block.kind === 'graph' ? 'y = sin(x)' : block.kind === 'calc' ? 'R = 4.7k ohm, then R || 10k ohm' : editing ? 'Type, or start with # - [] > for formatting' : ''
  const marker = block.kind === 'li' ? <span className="notes-bullet">•</span>
    : block.kind === 'ol' ? <span className="notes-bullet">{number}.</span>
    : block.kind === 'todo' ? <input type="checkbox" className="notes-check" checked={block.checked} onChange={onCheck} />
    : null
  const overdue = block.due && !block.checked && block.due <= Date.now()
  if (block.kind === 'drawing') return <div className="notes-block kind-drawing"><span className="notes-fold-space" /><DrawingBlock id={block.text} /></div>
  if (!editableAsText(block.kind)) return <div className="notes-block kind-other"><span className="notes-fold-space" /><p className="notes-other">{block.kind === 'ink' ? '✎ Handwriting' : block.kind === 'image' ? '🖼 Picture' : `A “${block.kind}” block`}, made with a newer BridgeDeck. Update BridgeDeck on this computer to see it; it’s kept as it is.</p></div>

  return <div className={`notes-block kind-${block.kind}${block.checked ? ' checked' : ''}`} style={{ paddingLeft: indentOf(block) * 26 }}>
    {folded !== null ? <button className="notes-fold" title={folded ? 'Show sub-tasks' : 'Hide sub-tasks'} onClick={onFold}>{folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span className="notes-fold-space" />}
    {marker}
    <div className="notes-block-body">
      {showArea
        ? <textarea ref={area} rows={1} spellCheck={!codeLike(block.kind)} value={block.text} placeholder={placeholder}
            onChange={e => { onText(e.target.value); const q = linkQuery(e.target.value, e.target.selectionStart); setSuggest(q ? { ...q, index: 0 } : null) }}
            onKeyDown={keyDown} onFocus={onFocused} onBlur={() => { window.setTimeout(() => setSuggest(null), 150); onBlurred() }} />
        : block.kind === 'graph' ? <PlotView text={block.text} onClick={onEdit} />
        : block.kind === 'calc' ? <CalcView text={block.text} onClick={onEdit} />
        : block.kind === 'p' && displayMath(block.text) !== null
          ? <div className="notes-rendered notes-math-block" onClick={onEdit} dangerouslySetInnerHTML={{ __html: renderMath(displayMath(block.text)!, true) }} />
          : <div className="notes-rendered" onClick={e => { if (!(e.target instanceof HTMLAnchorElement)) onEdit() }}>
            {block.kind === 'code' || block.kind === 'python' ? (block.text || <span className="hint">Python code</span>) : inline(block.text).map((piece, i) => {
              switch (piece.kind) {
                case 'bold': return <strong key={i}>{piece.text}</strong>
                case 'italic': return <em key={i}>{piece.text}</em>
                case 'strike': return <s key={i}>{piece.text}</s>
                case 'code': return <code key={i}>{piece.text}</code>
                case 'link': return <a key={i} href={piece.href} onClick={e => { e.preventDefault(); e.stopPropagation(); if (piece.href!.startsWith('book:')) openBookLink(piece.href!); else void openExternal(piece.href!) }}>{piece.text}</a>
                case 'wikilink': return <a key={i} href="#" className={`notes-wikilink${findByTitle(nav.notes, piece.target!) ? '' : ' missing'}`} title={findByTitle(nav.notes, piece.target!) ? `Open ${piece.target}` : `Create ${piece.target}`} onClick={e => { e.preventDefault(); e.stopPropagation(); nav.openTitle(piece.target!) }}>{piece.text}</a>
                case 'tag': return <a key={i} href="#" className="notes-tag" onClick={e => { e.preventDefault(); e.stopPropagation(); nav.filterTag(piece.text) }}>#{piece.text}</a>
                case 'math': return <span key={i} className="notes-math" dangerouslySetInnerHTML={{ __html: renderMath(piece.text, false) }} />
                default: return <span key={i}>{piece.text}</span>
              }
            })}
          </div>}
      {showArea && block.kind === 'graph' && <PlotView text={block.text} />}
      {showArea && block.kind === 'calc' && <CalcView text={block.text} />}
      {block.kind === 'python' && <PythonOutput code={block.text} />}
      {suggest && options.length > 0 && <div className="notes-suggest">
        {options.map((title, i) => <button key={title} className={i === suggest.index ? 'active' : ''} onMouseDown={e => { e.preventDefault(); pick(title) }}>
          {findByTitle(nav.notes, title) ? <Link2 size={12} /> : <FilePlus size={12} />}{findByTitle(nav.notes, title) ? title : `New note “${title}”`}
        </button>)}
      </div>}
    </div>
    {sub && <span className={`notes-sub-count${sub.done === sub.total ? ' all' : ''}`} title="Sub-tasks done">{sub.done}/{sub.total}</span>}
    {block.kind === 'todo' && <button className="notes-add-sub" title="Add a sub-task" onClick={onAddSub}><ListPlus size={13} /></button>}
    {block.kind === 'todo' && (pickingDue
      ? <span className="notes-due-pick">
          <input type="datetime-local" autoFocus defaultValue={toLocalInput(block.due ?? nextNineAm())}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setPickingDue(false) }}
            onBlur={e => { const ms = new Date(e.target.value).getTime(); if (!Number.isNaN(ms)) onDue(ms); setPickingDue(false) }} />
          {block.due && <button className="notes-icon" title="No due date" onMouseDown={e => e.preventDefault()} onClick={() => { onDue(null); setPickingDue(false) }}><X size={13} /></button>}
        </span>
      : <button className={`notes-due${block.due ? ' set' : ''}${overdue ? ' overdue' : ''}`} title="Due date and reminder" onClick={() => setPickingDue(true)}>
          <CalendarClock size={13} />{block.due ? formatDue(block.due) : ''}
        </button>)}
  </div>
}
