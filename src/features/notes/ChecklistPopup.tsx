import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, ListChecks, Plus } from 'lucide-react'
import { notesCreate, notesSave, type Note, type NotePatch } from '../../lib/bridge'
import { tabMenuStore } from '../../core/shortcuts'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { between, indentOf, newId, noteTitle, toggleTask, visible } from './model'
import { notesStore, openNoteRequest } from './state'

const CHOSEN_KEY = 'bridgedeck.quickChecklist'
const read = () => { try { return localStorage.getItem(CHOSEN_KEY) } catch { return null } }
const remember = (id: string) => { try { localStorage.setItem(CHOSEN_KEY, id) } catch { /* this run only */ } }

/** Shows the change at once; the saved note replaces it. */
async function save(patch: NotePatch) {
  notesStore.set(list => list.map(n => n.id === patch.id ? { ...n, blocks: n.blocks.map(b => patch.blocks?.find(p => p.id === b.id) ?? b).concat((patch.blocks ?? []).filter(p => !n.blocks.some(b => b.id === p.id))) } : n))
  const saved = await notesSave(patch)
  notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
}

/** A checklist one click from anywhere: a button by Search that opens it in a small popup, like a
 *  browser extension's. Which checklist it shows is remembered on this computer. */
export function ChecklistPopup() {
  const notes = useStore(notesStore)
  const lists = useMemo(() => notes.filter(n => n.kind === 'list' && !n.deleted), [notes])
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string | null>(read)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const note: Note | undefined = lists.find(n => n.id === chosen) ?? lists.find(n => n.pinned) ?? lists[0]
  const items = note ? visible(note).filter(b => b.kind === 'todo') : []
  const left = items.filter(b => !b.checked).length

  // Web pages sit above BridgeDeck's own window contents: they step aside while the popup is open.
  useEffect(() => { tabMenuStore.set(open); return () => tabMenuStore.set(false) }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  }, [open])

  const run = (work: Promise<unknown>) => void work.then(() => setError(''), e => setError(String(e)))

  function choose(id: string) {
    setChosen(id)
    remember(id)
  }

  function add() {
    const text = draft.replace(/\s+/g, ' ').trim()
    if (!note || !text) return
    // After the last open item (on a project board that's To do or Doing, not Done), else at the end.
    const blocks = visible(note)
    const lastOpen = [...blocks].reverse().find(b => b.kind === 'todo' && !b.checked)
    const after = lastOpen ? blocks.findIndex(b => b.id === lastOpen.id) : blocks.length - 1
    const pos = between(blocks[after]?.pos ?? '', blocks[after + 1]?.pos ?? '')
    setDraft('')
    run(save({ id: note.id, blocks: [{ id: newId(), kind: 'todo', text, checked: false, due: null, pos, updated: 0, by: '', deleted: false }] }))
  }

  async function newChecklist() {
    const created = await notesCreate('list', '')
    notesStore.set(list => [created, ...list])
    choose(created.id)
  }

  function openInNotes() {
    if (!note) return
    openNoteRequest.set(note.id)
    activateTab('notes')
    setOpen(false)
  }

  return <div className="quick-checklist" ref={box}>
    <button className={open ? 'icon-button active' : 'icon-button'} onClick={() => setOpen(o => !o)} title={open ? undefined : note ? `${noteTitle(note)} (${left} left)` : 'Checklist'} aria-label="Checklist" aria-expanded={open}>
      <ListChecks size={15} />{left > 0 && <em className="quick-checklist__count">{left > 99 ? '99+' : left}</em>}
    </button>
    {open && <div className="quick-checklist__popup" role="dialog" aria-label="Checklist">
      <header>
        {lists.length > 0
          ? <select value={note?.id ?? ''} onChange={e => choose(e.target.value)} aria-label="Which checklist">{lists.map(n => <option key={n.id} value={n.id}>{noteTitle(n)}</option>)}</select>
          : <strong>Checklist</strong>}
        <button className="icon-button" onClick={() => run(newChecklist())} title="New checklist" aria-label="New checklist"><Plus size={14} /></button>
        {note && <button className="icon-button" onClick={openInNotes} title="Open in Notes" aria-label="Open in Notes"><ExternalLink size={14} /></button>}
      </header>
      {note ? <>
        <ul>
          {items.map(item => <li key={item.id} style={{ paddingLeft: indentOf(item) * 16 }} className={item.checked ? 'done' : undefined}>
            <label><input type="checkbox" checked={item.checked} onChange={() => run(save({ id: note.id, blocks: toggleTask(visible(note), item.id) }))} /><span>{item.text || 'Untitled'}</span></label>
          </li>)}
          {!items.length && <li className="empty">Nothing on this list yet.</li>}
        </ul>
        <form onSubmit={e => { e.preventDefault(); add() }}><input autoFocus placeholder="Add an item" value={draft} onChange={e => setDraft(e.target.value)} /></form>
      </> : <p className="empty">No checklists yet. Press + to make one.</p>}
      {error && <p className="error-text">{error}</p>}
    </div>}
  </div>
}
