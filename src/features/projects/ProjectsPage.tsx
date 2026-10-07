import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, CalendarPlus, FilePlus, FileText, FolderInput, FolderKanban, FolderOpen, ListChecks, MessageCircleQuestion, NotebookPen, Plus } from 'lucide-react'
import { askChatGPT, projectPrompt } from '../../core/chatgpt'
import { calendarSave, notesCreateMarkdown, notesSave, openPath, projectsAdd, projectsFiles, projectsImportMimir, type CalEvent, type Note, type NotePatch, type ProjectFile } from '../../lib/bridge'
import { usePeriodicRefresh } from '../../core/refresh'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle } from '../../ui'
import { eventsStore, refreshEvents } from '../calendar/state'
import { dateInput, formatRange } from '../calendar/model'
import { formatDue, newId, noteTitle } from '../notes/model'
import { notesStore, openNoteRequest } from '../notes/state'
import { fmtBytes } from '../study/model'
import { addCard, BOARD_MARKDOWN, boardColumns, boardProgress, boardTitle, countdown, moveCard, projectEvents, projectFolder, tickCard } from './model'
import { projectsStore, refreshProjects } from './state'
import { PartsCard, TimelineCard } from './ProjectPlan'

export default function ProjectsPage({ active }: { active: boolean }) {
  const { list, error } = useStore(projectsStore)
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [status, setStatus] = useState('')
  usePeriodicRefresh(async () => { if (active) await refreshProjects() }, 15_000, [active])
  const projects = list?.projects ?? []
  const project = projects.find(p => p.name === selected) ?? projects[0] ?? null
  useEffect(() => { if (!selected && projects[0]) setSelected(projects[0].name) }, [selected, projects])

  async function add() {
    if (!name.trim()) return
    try {
      const made = await projectsAdd(name)
      setName('')
      await refreshProjects()
      setSelected(made)
    } catch (e) { setStatus(String(e)) }
  }

  async function bringIn() {
    try {
      const count = await projectsImportMimir()
      setStatus(`Copied ${count} project${count === 1 ? '' : 's'} from Mimir's old folder; the originals are still there.`)
      await refreshProjects()
    } catch (e) { setStatus(String(e)) }
  }

  return <div className="study-layout">
    <aside className="card study-courses">
      <SectionTitle title="Projects" subtitle="Files, notes, a task board and milestones" />
      <div className="study-course-list">
        {projects.map(p => <button key={p.name} className={p.name === project?.name ? 'active' : ''} onClick={() => setSelected(p.name)}>
          <FolderKanban size={15} /><span>{p.name}</span><small>{p.files}</small>
        </button>)}
      </div>
      <form className="study-new" onSubmit={e => { e.preventDefault(); void add() }}>
        <input placeholder="New project" value={name} onChange={e => setName(e.target.value)} />
        <button className="cal-icon" title="Add project" disabled={!name.trim()}><Plus size={16} /></button>
      </form>
      {list && list.mimirOld.length > 0 && <div className="project-import">
        <p className="hint">Mimir has {list.mimirOld.length} project{list.mimirOld.length === 1 ? '' : 's'} in {list.mimirOldPath} ({list.mimirOld.slice(0, 3).join(', ')}{list.mimirOld.length > 3 ? '…' : ''}). Mimir now uses this Projects folder.</p>
        <button className="ghost" onClick={() => void bringIn()}><FolderInput size={14} /> Copy them here</button>
      </div>}
      {list && <p className="hint">Projects are kept in {list.root}, which Sync shares with your other computer. Mimir works in the same folder.</p>}
      {(error || status) && <p className={error ? 'cal-error' : 'book-status'}>{error || status}</p>}
    </aside>
    {project ? <ProjectView key={project.name} name={project.name} root={list!.root} onStatus={setStatus} />
      : <Card className="study-empty"><FolderKanban size={28} /><h3>Make your first project</h3><p>Each project gets a folder on both computers, a task board, notes and milestones, and Mimir can work with all of it.</p></Card>}
  </div>
}

function ProjectView({ name, root, onStatus }: { name: string; root: string; onStatus: (s: string) => void }) {
  const notes = useStore(notesStore)
  const events = useStore(eventsStore)
  const folder = projectFolder(name)
  const mine = useMemo(() => notes.filter(n => !n.deleted && n.folder.toLowerCase() === folder.toLowerCase()), [notes, folder])
  const board = mine.find(n => n.title === boardTitle(name))
  const progress = boardProgress(board)
  const upcoming = useMemo(() => projectEvents(events, name).slice(0, 8), [events, name])
  const milestones = useMemo(() => events.filter(e => !e.deleted && !e.repeat && e.title.toLowerCase().includes(name.toLowerCase())), [events, name])
  const [files, setFiles] = useState<ProjectFile[] | null>(null)
  usePeriodicRefresh(async () => { try { setFiles(await projectsFiles(name)) } catch { setFiles([]) } }, 15_000, [name])

  async function makeNote(title: string, kind: 'note' | 'list', markdown: string, open: boolean) {
    try {
      const note = await notesCreateMarkdown(title, folder, kind, markdown)
      notesStore.set(list => [note, ...list])
      if (open) { openNoteRequest.set(note.id); activateTab('notes') }
    } catch (e) { onStatus(String(e)) }
  }

  return <div className="study-course">
    <Card><SectionTitle title={name} subtitle={`${files?.length ?? '…'} files · ${mine.length} notes${progress.total ? ` · ${progress.done}/${progress.total} tasks done` : ''}`}
      action={<div className="actions"><button className="secondary" onClick={() => void openPath(`${root}/${name}`)}><FolderOpen size={15} />Folder</button>
        <button className="secondary" title="Open ChatGPT with this project's board and milestones, ready for you to send" onClick={() => void askChatGPT(projectPrompt(name, board ? boardColumns(board).map(c => ({ title: c.title, cards: c.cards.filter(k => !k.block.checked).map(k => k.block.text) })) : [], upcoming.map(e => `${e.title} on ${new Date(e.start).toLocaleDateString()}`)), folder).catch(e => onStatus(String(e)))}><MessageCircleQuestion size={15} />Ask ChatGPT</button></div>} />
      {board ? <Board note={board} onStatus={onStatus} /> : <div className="empty-state small"><ListChecks size={22} /><h3>No task board yet</h3><p>A board is a checklist note with a heading per column (To do, Doing, Done), so it also works in Notes and Obsidian.</p>
        <button onClick={() => void makeNote(boardTitle(name), 'list', BOARD_MARKDOWN, false)}>Make the board</button></div>}
    </Card>
    <TimelineCard board={board} milestones={milestones} />
    <div className="two-col">
      <Card><SectionTitle title="Milestones" subtitle="From your calendar (events with the project name)" />
        {upcoming.length ? <div className="agenda-list">{upcoming.map(e => <button key={e.id} className="agenda-row" onClick={() => activateTab('calendar')}>
          <i style={{ background: '#c792ea' }} /><span className="agenda-time">{new Date(e.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} {formatRange(e)}</span><span className="grow agenda-title">{e.title}</span><small>{countdown(e.start)}</small></button>)}</div>
          : <p className="hint">No milestones coming up.</p>}
        <Milestone project={name} onStatus={onStatus} />
      </Card>
      <Card><SectionTitle title="Notes" subtitle={`In Notes, folder ${folder}`} action={<button className="ghost" onClick={() => void makeNote(`${name} notes`, 'note', '', true)}><FilePlus size={14} /> New note</button>} />
        {mine.length ? <div className="study-notes">{mine.map(note => <button key={note.id} onClick={() => { openNoteRequest.set(note.id); activateTab('notes') }}>
          {note.kind === 'list' ? <ListChecks size={14} /> : <NotebookPen size={14} />}<span className="grow">{noteTitle(note)}</span></button>)}</div> : <p className="hint">Nothing yet.</p>}
      </Card>
    </div>
    <PartsCard project={name} root={root} />
    <Card><SectionTitle title="Files" subtitle="Newest first. Drop files into the folder; Mimir can read and write them too." />
      {files?.length ? <div className="project-files">{files.slice(0, 60).map(f => <button key={f.path} onClick={() => void openPath(`${root}/${name}/${f.path}`)} title={f.path}>
        <FileText size={14} /><span className="grow">{f.path}</span><small>{fmtBytes(f.bytes)}</small><small>{f.modified ? new Date(f.modified).toLocaleDateString() : ''}</small></button>)}</div>
        : <p className="hint">{files ? 'The folder is empty.' : 'Reading…'}</p>}
    </Card>
  </div>
}

function Board({ note, onStatus }: { note: Note; onStatus: (s: string) => void }) {
  const columns = boardColumns(note)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [picking, setPicking] = useState<string | null>(null)

  async function save(patch: NotePatch | null) {
    if (!patch) return
    // Show it straight away; the saved note replaces it.
    notesStore.set(list => list.map(n => n.id === note.id ? { ...n, blocks: n.blocks.map(b => patch.blocks?.find(p => p.id === b.id) ?? b).concat((patch.blocks ?? []).filter(p => !n.blocks.some(b => b.id === p.id))) } : n))
    try {
      const saved = await notesSave(patch)
      notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
    } catch (e) { onStatus(String(e)) }
  }

  if (!columns.length) return <p className="hint">This board has no columns; add “## To do” style headings to its note.</p>
  return <div className="board" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))` }}>
    {columns.map((column, ci) => <div key={column.heading?.id ?? ci} className={`board-column${over === ci ? ' over' : ''}`}
      onDragOver={e => { if (dragging) { e.preventDefault(); setOver(ci) } }} onDragLeave={() => setOver(o => o === ci ? null : o)}
      onDrop={e => { e.preventDefault(); setOver(null); if (dragging) void save(moveCard(note, dragging, ci, column.cards.length - 1)); setDragging(null) }}>
      <div className="board-head"><strong>{column.title}</strong><small>{column.cards.length}</small></div>
      {column.cards.map((card, i) => <div key={card.block.id} className={`board-card${card.block.checked ? ' done' : ''}`} draggable
        onDragStart={e => { setDragging(card.block.id); e.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => { setDragging(null); setOver(null) }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); setOver(null); if (dragging && dragging !== card.block.id) void save(moveCard(note, dragging, ci, i - 1)); setDragging(null) }}>
        <label><input type="checkbox" checked={card.block.checked} onChange={e => void save(tickCard(note, card.block.id, e.target.checked))} /><span>{card.block.text || 'Untitled'}</span>
          <button type="button" className="notes-icon board-due" title="Due date" onClick={e => { e.preventDefault(); setPicking(p => p === card.block.id ? null : card.block.id) }}><CalendarClock size={12} /></button></label>
        {picking === card.block.id && <div className="board-due-pick">
          <input type="date" autoFocus defaultValue={card.block.due ? dateInput(card.block.due) : ''} onChange={e => {
            const [y, m, d] = e.target.value.split('-').map(Number)
            // Due at the end of the working day, so the reminder comes that afternoon.
            if (y) void save({ id: note.id, blocks: [{ ...card.block, due: new Date(y, m - 1, d, 17).getTime() }] })
            setPicking(null)
          }} />
          {card.block.due && <button type="button" className="ghost" onClick={() => { void save({ id: note.id, blocks: [{ ...card.block, due: null }] }); setPicking(null) }}>No date</button>}
        </div>}
        {(card.subs.length > 0 || card.block.due) && <div className="board-meta">
          {card.subs.length > 0 && <small>{card.subs.filter(s => s.checked).length}/{card.subs.length} sub-tasks</small>}
          {card.block.due && <small className={!card.block.checked && card.block.due <= Date.now() ? 'overdue' : ''}>{formatDue(card.block.due)}</small>}
        </div>}
      </div>)}
      <form className="board-add" onSubmit={e => { e.preventDefault(); void save(addCard(note, ci, drafts[ci] ?? '')); setDrafts(d => ({ ...d, [ci]: '' })) }}>
        <input placeholder="Add a card" value={drafts[ci] ?? ''} onChange={e => setDrafts(d => ({ ...d, [ci]: e.target.value }))} />
      </form>
    </div>)}
  </div>
}

function Milestone({ project, onStatus }: { project: string; onStatus: (s: string) => void }) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(() => dateInput(Date.now() + 14 * 86_400_000))
  async function add() {
    if (!title.trim()) return
    // An all-day event, so it shows as the day it's due in any time zone the calendar is read in.
    const [y, m, d] = date.split('-').map(Number)
    const event: CalEvent = { id: newId(), title: `${project}: ${title.trim()}`, start: new Date(y, m - 1, d).getTime(), end: new Date(y, m - 1, d + 1).getTime(), allDay: true, location: '', notes: '', color: 'purple', repeat: null, skip: [], reminder: 1440, updated: 0, by: '', deleted: false, seq: 0 }
    try {
      const saved = await calendarSave(event)
      eventsStore.set(list => [...list, saved])
      void refreshEvents()
      setTitle('')
    } catch (e) { onStatus(String(e)) }
  }
  return <form className="study-exam" onSubmit={e => { e.preventDefault(); void add() }}>
    <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Milestone, e.g. Prototype demo" />
    <input type="date" value={date} onChange={e => setDate(e.target.value)} />
    <button className="ghost" disabled={!title.trim()}><CalendarPlus size={14} /> Add</button>
  </form>
}
