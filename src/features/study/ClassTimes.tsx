import { useState } from 'react'
import { CalendarRange, CalendarX, Clock, Plus, Trash2 } from 'lucide-react'
import { calendarSave, finalsPage, studyPatchCourseInfo, type CalEvent, type StudyCourse } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { classChangesOf, DAY_LETTERS, dayKey, meetingsOf, meetingText, type ClassChange, type Meeting, type Term } from './schedule'
import { eventsStore } from '../calendar/state'
import { newId } from '../notes/model'
import { finalFor, readFinals, tableText } from './finals'
import { configStore } from '../../core/config'
import { libraryStore, refreshLibrary, saveTerm, termStore } from './state'

/** A course's weekly class times: they show in the Calendar and on Home, and date homework. */
export function ClassTimes({ course, onStatus }: { course: StudyCourse; onStatus: (s: string) => void }) {
  const meetings = meetingsOf(course.info)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Meeting>({ days: [], start: '10:00', end: '11:15', room: '', kind: '' })
  async function save(list: Meeting[]) {
    try { await studyPatchCourseInfo(course.name, { meetings: list }); await refreshLibrary() } catch (e) { onStatus(errorText(e, 'Couldn’t save the class times')) }
  }
  const toggleDay = (d: number) => setDraft(m => ({ ...m, days: m.days.includes(d) ? m.days.filter(x => x !== d) : [...m.days, d].sort() }))
  // One-off changes: a class cancelled, or in another room, on one date.
  const changes = classChangesOf(course.info)
  const today = dayKey(Date.now())
  const upcoming = changes.filter(c => c.date >= today).sort((a, b) => a.date.localeCompare(b.date))
  const [changing, setChanging] = useState(false)
  const [change, setChange] = useState<{ date: string; cancelled: boolean; room: string }>({ date: today, cancelled: true, room: '' })
  async function saveChanges(list: ClassChange[]) {
    // Changes more than a month old are dropped.
    const keep = dayKey(Date.now() - 31 * 86_400_000)
    try { await studyPatchCourseInfo(course.name, { classChanges: list.filter(c => c.date >= keep) }); await refreshLibrary() } catch (e) { onStatus(errorText(e, 'Couldn’t save the change')) }
  }
  const day = (d: string) => new Date(`${d}T00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return <><div className="class-times">
    <Clock size={13} />
    {meetings.length ? meetings.map((m, i) => <span key={i} className="class-time">{m.kind ? <b>{m.kind} </b> : null}{meetingText(m)}
      <button className="cal-icon" title="Remove" onClick={() => void save(meetings.filter((_, j) => j !== i))}><Trash2 size={11} /></button></span>)
      : <span className="hint">No class times yet</span>}
    {!editing ? <button className="ghost" onClick={() => setEditing(true)}><Plus size={12} />Class time</button>
      : <form className="class-time-add" onSubmit={e => { e.preventDefault(); if (draft.days.length && draft.start < draft.end) { void save([...meetings, draft]); setEditing(false); setDraft(d => ({ ...d, days: [] })) } }}>
        <span className="class-days">{DAY_LETTERS.slice(0, 6).map((l, i) => <button type="button" key={l} className={draft.days.includes(i + 1) ? 'on' : ''} onClick={() => toggleDay(i + 1)}>{l}</button>)}</span>
        <input type="time" value={draft.start} onChange={e => setDraft(m => ({ ...m, start: e.target.value }))} />
        <input type="time" value={draft.end} onChange={e => setDraft(m => ({ ...m, end: e.target.value }))} />
        <input placeholder="Room" value={draft.room} onChange={e => setDraft(m => ({ ...m, room: e.target.value }))} />
        <select value={draft.kind} onChange={e => setDraft(m => ({ ...m, kind: e.target.value }))}><option value="">Class</option><option>Lecture</option><option>Lab</option><option>Discussion</option><option>Office hours</option></select>
        <button disabled={!draft.days.length || draft.start >= draft.end}>Add</button>
        <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
      </form>}
    {!!meetings.length && !changing && <button className="ghost" title="Cancel one class, or move it to another room, on one date" onClick={() => setChanging(true)}><CalendarX size={12} />Change a class</button>}
  </div>
  {(!!upcoming.length || changing) && <div className="class-times class-changes">
    {upcoming.map(c => <span key={c.date} className="class-time">{day(c.date)}: {c.cancelled ? <b>no class</b> : <>in <b>{c.room}</b></>}
      <button className="cal-icon" title="Undo" onClick={() => void saveChanges(changes.filter(x => x.date !== c.date))}><Trash2 size={11} /></button></span>)}
    {changing && <form className="class-time-add" onSubmit={e => { e.preventDefault(); if (!change.date || (!change.cancelled && !change.room.trim())) return; void saveChanges([...changes.filter(c => c.date !== change.date), change.cancelled ? { date: change.date, cancelled: true } : { date: change.date, room: change.room.trim() }]); setChanging(false) }}>
      <input type="date" value={change.date} min={today} onChange={e => setChange(c => ({ ...c, date: e.target.value }))} />
      <select value={change.cancelled ? 'cancel' : 'room'} onChange={e => setChange(c => ({ ...c, cancelled: e.target.value === 'cancel' }))}><option value="cancel">No class</option><option value="room">Another room</option></select>
      {!change.cancelled && <input placeholder="Room" value={change.room} onChange={e => setChange(c => ({ ...c, room: e.target.value }))} />}
      <button>Save</button>
      <button type="button" className="ghost" onClick={() => setChanging(false)}>Cancel</button>
    </form>}
  </div>}
  </>
}

const fmt = (d: string) => new Date(`${d}T00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })

/** The semester's first and last days and its breaks: classes aren't shown outside them. */
export function TermCard() {
  const term = useStore(termStore)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Term>(() => term ?? { start: '', end: '', breaks: [] })
  const [brk, setBrk] = useState({ name: '', start: '', end: '' })
  const [error, setError] = useState('')
  const [finals, setFinals] = useState('')
  const [finalsStatus, setFinalsStatus] = useState('')
  /** Each course's final from the pasted finals schedule, put in the calendar (where the exam
   *  cards and reminders find it); the room is added on the exam once it's known. */
  const [finalsUrl, setFinalsUrl] = useState(() => configStore.get().study.finalsUrl ?? '')
  /** The schedule read from the university's page (remembered for next term), then added. */
  async function readPage() {
    setFinalsStatus('Reading the page…')
    try {
      const text = tableText(await finalsPage(finalsUrl))
      configStore.set(c => ({ ...c, study: { ...c.study, finalsUrl: finalsUrl.trim() } }))
      setFinals(text)
      await addFinals(text)
    } catch (e) { setFinalsStatus(errorText(e, 'Couldn’t read the page')) }
  }
  async function addFinals(source = finals) {
    const rows = readFinals(source)
    if (!rows.length) return setFinalsStatus('No rows read: paste the table with the class days and times, the date, and the exam time.')
    const year = Number((draft.end || new Date().toISOString()).slice(0, 4))
    const events = eventsStore.get()
    const added: string[] = [], missed: string[] = []
    for (const c of libraryStore.get().library?.courses.filter(c => !c.archived) ?? []) {
      const meetings = meetingsOf(c.info)
      if (!meetings.length) continue
      const f = finalFor(meetings, rows, year)
      if (!f) { missed.push(c.name); continue }
      const title = `${c.name}: Final`
      if (events.some(e => !e.deleted && e.title === title && Math.abs(e.start - f.start) < 86_400_000)) continue
      const event: CalEvent = { id: newId(), title, start: f.start, end: f.end, allDay: false, location: '', notes: 'From the finals schedule', color: 'red', repeat: null, skip: [], reminder: 1440, updated: 0, by: '', deleted: false, seq: 0 }
      try { const saved = await calendarSave(event); eventsStore.set(list => [...list, saved]); added.push(c.name) } catch (e) { setFinalsStatus(errorText(e, 'Couldn’t add it')); return }
    }
    setFinalsStatus(`${added.length ? `Added finals for ${added.join(', ')}.` : 'No new finals added.'}${missed.length ? ` No row matched ${missed.join(', ')}: check its class times.` : ''}`)
  }
  async function save(next: Term) {
    setError('')
    try { await saveTerm(next.start && next.end ? next : null) } catch (e) { setError(errorText(e, 'Couldn’t save it')) }
  }
  if (!open) return <button className="ghost study-term" onClick={() => { setDraft(term ?? { start: '', end: '', breaks: [] }); setOpen(true) }}>
    <CalendarRange size={13} />{term ? `Semester ${fmt(term.start)} – ${fmt(term.end)}${term.breaks.length ? ` · ${term.breaks.length} break${term.breaks.length === 1 ? '' : 's'}` : ''}` : 'Set the semester’s dates'}
  </button>
  return <div className="study-term-edit">
    <label>First day<input type="date" value={draft.start} onChange={e => setDraft(d => ({ ...d, start: e.target.value }))} /></label>
    <label>Last day<input type="date" value={draft.end} onChange={e => setDraft(d => ({ ...d, end: e.target.value }))} /></label>
    <strong>Breaks and holidays</strong>
    {draft.breaks.map((b, i) => <div key={i} className="study-break">{b.name || 'Break'} · {fmt(b.start)}{b.end !== b.start ? `–${fmt(b.end)}` : ''}<button className="cal-icon" onClick={() => setDraft(d => ({ ...d, breaks: d.breaks.filter((_, j) => j !== i) }))}><Trash2 size={11} /></button></div>)}
    <div className="study-break-add">
      <input placeholder="Labor Day" value={brk.name} onChange={e => setBrk(b => ({ ...b, name: e.target.value }))} />
      <input type="date" value={brk.start} onChange={e => setBrk(b => ({ ...b, start: e.target.value, end: b.end || e.target.value }))} />
      <input type="date" value={brk.end} onChange={e => setBrk(b => ({ ...b, end: e.target.value }))} />
      <button className="ghost" disabled={!brk.start} onClick={() => { setDraft(d => ({ ...d, breaks: [...d.breaks, { ...brk, end: brk.end || brk.start }].sort((a, b) => a.start.localeCompare(b.start)) })); setBrk({ name: '', start: '', end: '' }) }}><Plus size={12} /></button>
    </div>
    <div className="actions"><button disabled={!draft.start || !draft.end || draft.start > draft.end} onClick={() => void save(draft).then(() => setOpen(false))}>Save</button><button className="ghost" onClick={() => setOpen(false)}>Cancel</button></div>
    {error && <p className="cal-error">{error}</p>}
    <strong>Finals schedule</strong>
    <div className="study-break-add"><input placeholder="The finals schedule page (https://…)" value={finalsUrl} onChange={e => setFinalsUrl(e.target.value)} /><button className="ghost" disabled={!finalsUrl.trim()} title="Read the table from the page and add the finals (the address is kept for next term)" onClick={() => void readPage()}>Read it</button></div>
    <textarea rows={4} placeholder="…or paste the university's finals table (class days and time, exam date, exam time)" value={finals} onChange={e => setFinals(e.target.value)} />
    <button className="ghost" disabled={!finals.trim()} title="Matches each course's lecture time to its row" onClick={() => void addFinals()}>Add finals to the calendar</button>
    {finalsStatus && <p className="hint">{finalsStatus}</p>}
  </div>
}
