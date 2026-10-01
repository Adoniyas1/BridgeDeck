import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CalendarClock, CheckSquare, Code, Copy, FilePlus, Folder, Heading1, Heading2, List, ListChecks, ListOrdered, Pilcrow, Pin, PinOff, Quote, Search, Trash2, X } from 'lucide-react'
import { notesCreate, notesDelete, notesSave, openExternal, type Note, type NoteBlock, type NoteBlockKind } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { between, diff, folders, formatDue, inline, matches, newId, nextKind, noteTitle, preview, rebase, shortcut, toMarkdown, visible } from './model'
import { notesLoadedStore, notesStore, refreshNotes } from './state'

const KINDS: Array<[NoteBlockKind, string, typeof Pilcrow]> = [
  ['p', 'Text', Pilcrow], ['h1', 'Heading', Heading1], ['h2', 'Subheading', Heading2], ['li', 'Bulleted list', List],
  ['ol', 'Numbered list', ListOrdered], ['todo', 'Checklist', CheckSquare], ['quote', 'Quote', Quote], ['code', 'Code', Code],
]

/** "All", "Pinned" or a folder name. */
type Filter = { kind: 'all' } | { kind: 'pinned' } | { kind: 'folder'; name: string }

export default function NotesPage() {
  const notes = useStore(notesStore)
  const loaded = useStore(notesLoadedStore)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [openId, setOpenId] = useState<string | null>(null)
  const [freshId, setFreshId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const shown = useMemo(() => notes.filter(n => matches(n, query) && (filter.kind === 'all' || (filter.kind === 'pinned' ? n.pinned : n.folder === filter.name))), [notes, query, filter])
  const folderNames = useMemo(() => folders(notes), [notes])
  const open = notes.find(n => n.id === openId) ?? null

  useEffect(() => { if (!openId && shown.length) setOpenId(shown[0].id) }, [openId, shown])

  async function create(kind: 'note' | 'list') {
    setError('')
    try {
      const note = await notesCreate(kind, filter.kind === 'folder' ? filter.name : '')
      notesStore.set(current => [note, ...current])
      setQuery('')
      setOpenId(note.id)
      setFreshId(note.id)
    } catch (e) { setError(String(e)) }
  }

  return <div className="notes-layout">
    <aside className="card notes-sidebar">
      <div className="notes-search"><Search size={14} /><input placeholder="Search notes" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="notes-icon" title="Clear" onClick={() => setQuery('')}><X size={13} /></button>}</div>
      <div className="actions notes-new">
        <button onClick={() => void create('note')}><FilePlus size={15} />Note</button>
        <button onClick={() => void create('list')}><ListChecks size={15} />Checklist</button>
      </div>
      <div className="notes-filters">
        <button className={filter.kind === 'all' ? 'active' : ''} onClick={() => setFilter({ kind: 'all' })}>All <small>{notes.length}</small></button>
        <button className={filter.kind === 'pinned' ? 'active' : ''} onClick={() => setFilter({ kind: 'pinned' })}><Pin size={12} />Pinned</button>
        {folderNames.map(name => <button key={name} className={filter.kind === 'folder' && filter.name === name ? 'active' : ''} onClick={() => setFilter({ kind: 'folder', name })}><Folder size={12} />{name}</button>)}
      </div>
      {error && <p className="notes-error">{error}</p>}
      <div className="notes-list">
        {shown.map(n => <button key={n.id} className={n.id === openId ? 'active' : ''} onClick={() => setOpenId(n.id)}>
          <strong>{n.pinned && <Pin size={11} />}{n.kind === 'list' && <ListChecks size={12} />}{noteTitle(n)}</strong>
          <small>{preview(n) || (n.folder ? n.folder : 'Empty')}</small>
        </button>)}
        {loaded && !shown.length && <p className="notes-empty">{query ? 'No notes match.' : notes.length ? 'Nothing here.' : 'No notes yet. They’re kept on every paired computer.'}</p>}
      </div>
    </aside>
    {open ? <NoteEditor key={open.id} stored={open} fresh={open.id === freshId} folderNames={folderNames} onDeleted={() => setOpenId(null)} />
      : <section className="card notes-editor notes-blank"><p>{loaded ? 'Pick a note or make a new one.' : 'Loading notes…'}</p></section>}
  </div>
}

type Focus = { id: string; caret: number | 'end' } | null

/** Edits one note. Changes are saved half a second after typing stops, as a patch of what changed,
 *  so a change that arrives from another computer meanwhile is merged rather than undone. */
function NoteEditor({ stored, fresh, folderNames, onDeleted }: { stored: Note; fresh: boolean; folderNames: string[]; onDeleted: () => void }) {
  const base = useRef(stored)
  const [draft, setDraftState] = useState(stored)
  const draftRef = useRef(stored)
  const [focus, setFocus] = useState<Focus>(() => fresh && stored.kind === 'list' && stored.blocks[0] ? { id: stored.blocks[0].id, caret: 0 } : null)
  const [editing, setEditing] = useState<string | null>(null)
  const [status, setStatus] = useState('')
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

  function updateBlock(id: string, changes: Partial<NoteBlock>) {
    change({ ...draftRef.current, blocks: draftRef.current.blocks.map(b => b.id === id ? { ...b, ...changes } : b) })
  }

  function insertAfter(id: string | null, block: Partial<NoteBlock>, current = draftRef.current) {
    const list = visible(current)
    const at = id ? list.findIndex(b => b.id === id) : list.length - 1
    const pos = between(list[at]?.pos ?? '', list[at + 1]?.pos ?? '')
    const added: NoteBlock = { id: newId(), kind: 'p', text: '', checked: false, due: null, pos, updated: 0, by: '', deleted: false, ...block }
    change({ ...current, blocks: [...current.blocks, added] })
    setFocus({ id: added.id, caret: 0 })
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
    const collapsed = area.selectionStart === area.selectionEnd
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && block.kind === 'todo') {
      event.preventDefault()
      updateBlock(block.id, { checked: !block.checked })
    } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && (block.kind === 'code' ? event.shiftKey : !event.shiftKey)) {
      event.preventDefault()
      if (!block.text && block.kind !== 'p' && block.kind !== 'code') { updateBlock(block.id, { kind: 'p' }); return }
      const before = block.text.slice(0, caret)
      const after = block.text.slice(area.selectionEnd)
      const current = { ...draftRef.current, blocks: draftRef.current.blocks.map(b => b.id === block.id ? { ...b, text: before } : b) }
      insertAfter(block.id, { kind: nextKind(block.kind), text: after, due: null }, current)
    } else if (event.key === 'Backspace' && collapsed && caret === 0) {
      if (block.kind !== 'p') { event.preventDefault(); updateBlock(block.id, { kind: 'p' }); return }
      const previous = blocks[index - 1]
      if (!previous) return
      event.preventDefault()
      const current = { ...draftRef.current, blocks: draftRef.current.blocks.map(b => b.id === previous.id ? { ...b, text: previous.text + block.text } : b) }
      removeBlock(block.id, current)
      setFocus({ id: previous.id, caret: previous.text.length })
    } else if (event.key === 'ArrowUp' && collapsed && !block.text.slice(0, caret).includes('\n') && blocks[index - 1]) {
      event.preventDefault()
      setFocus({ id: blocks[index - 1].id, caret: 'end' })
    } else if (event.key === 'ArrowDown' && collapsed && !block.text.slice(caret).includes('\n') && blocks[index + 1]) {
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
    if (!id) return
    updateBlock(id, { kind })
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
  let number = 0

  return <section className="card notes-editor">
    <div className="notes-toolbar">
      <div className="notes-kinds">
        {KINDS.map(([kind, label, Icon]) => <button key={kind} className="notes-icon" title={label} onMouseDown={e => e.preventDefault()} onClick={() => setKind(kind)}><Icon size={15} /></button>)}
      </div>
      <div className="notes-meta">
        <label className="notes-folder" title="Folder"><Folder size={13} /><input list="notes-folders" placeholder="No folder" value={draft.folder} onChange={e => change({ ...draftRef.current, folder: e.target.value })} /></label>
        <datalist id="notes-folders">{folderNames.map(f => <option key={f} value={f} />)}</datalist>
        <button className="notes-icon" title={draft.pinned ? 'Unpin' : 'Pin to the top'} onClick={() => change({ ...draftRef.current, pinned: !draftRef.current.pinned })}>{draft.pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>
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
    <div className="notes-blocks">
      {blocks.map((block, index) => {
        number = block.kind === 'ol' ? number + 1 : 0
        return <BlockRow key={block.id} block={block} number={number} editing={editing === block.id} focus={focus?.id === block.id ? focus : null}
          onFocused={() => { setEditing(block.id); lastKindTarget.current = block.id; setFocus(null) }}
          onBlurred={() => setEditing(current => current === block.id ? null : current)}
          onText={text => onText(block, text)} onKey={e => onKey(e, block, index)}
          onCheck={() => updateBlock(block.id, { checked: !block.checked })}
          onDue={due => updateBlock(block.id, { due })}
          onEdit={() => setFocus({ id: block.id, caret: 'end' })} />
      })}
      <div className="notes-tail" onClick={() => {
        const last = blocks[blocks.length - 1]
        if (last && !last.text) setFocus({ id: last.id, caret: 0 })
        else insertAfter(last?.id ?? null, { kind: draft.kind === 'list' ? 'todo' : 'p' })
      }} />
    </div>
    <p className="notes-status">{status || 'Markdown works: # heading, - list, [] checklist, > quote, ``` code. ⌘/Ctrl+Enter ticks an item.'}</p>
  </section>
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

function BlockRow({ block, number, editing, focus, onFocused, onBlurred, onText, onKey, onCheck, onDue, onEdit }: {
  block: NoteBlock; number: number; editing: boolean; focus: Focus
  onFocused: () => void; onBlurred: () => void; onText: (text: string) => void; onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onCheck: () => void; onDue: (due: number | null) => void; onEdit: () => void
}) {
  const area = useRef<HTMLTextAreaElement>(null)
  const [pickingDue, setPickingDue] = useState(false)
  const showArea = editing || focus !== null || !block.text

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

  const placeholder = block.kind === 'todo' ? 'To do' : block.kind.startsWith('h') ? 'Heading' : block.kind === 'code' ? 'Code' : editing ? 'Type, or start with # - [] > for formatting' : ''
  const marker = block.kind === 'li' ? <span className="notes-bullet">•</span>
    : block.kind === 'ol' ? <span className="notes-bullet">{number}.</span>
    : block.kind === 'todo' ? <input type="checkbox" className="notes-check" checked={block.checked} onChange={onCheck} />
    : null
  const overdue = block.due && !block.checked && block.due <= Date.now()

  return <div className={`notes-block kind-${block.kind}${block.checked ? ' checked' : ''}`}>
    {marker}
    <div className="notes-block-body">
      {showArea
        ? <textarea ref={area} rows={1} spellCheck={block.kind !== 'code'} value={block.text} placeholder={placeholder}
            onChange={e => onText(e.target.value)} onKeyDown={onKey} onFocus={onFocused} onBlur={onBlurred} />
        : <div className="notes-rendered" onClick={e => { if (!(e.target instanceof HTMLAnchorElement)) onEdit() }}>
            {block.kind === 'code' ? block.text : inline(block.text).map((piece, i) => {
              switch (piece.kind) {
                case 'bold': return <strong key={i}>{piece.text}</strong>
                case 'italic': return <em key={i}>{piece.text}</em>
                case 'strike': return <s key={i}>{piece.text}</s>
                case 'code': return <code key={i}>{piece.text}</code>
                case 'link': return <a key={i} href={piece.href} onClick={e => { e.preventDefault(); void openExternal(piece.href!) }}>{piece.text}</a>
                default: return <span key={i}>{piece.text}</span>
              }
            })}
          </div>}
    </div>
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
