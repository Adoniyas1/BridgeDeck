import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarPlus, ChevronLeft, ChevronRight, Download, ExternalLink, GraduationCap, ListChecks, MapPin, RefreshCw, Repeat, Trash2, Upload, X } from 'lucide-react'
import { calendarDelete, calendarImport, calendarReadIcs, calendarSave, calendarWriteIcs, pickIcsFile, type CalEvent, type CalRepeat } from '../../lib/bridge'
import { useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { openInNewTab } from '../browser/state'
import { newId } from '../notes/model'
import { fromIcs, toIcs } from './ics'
import { touchesDay, addDays, addMonths, colorOf, COLORS, dateInput, DAY, formatRange, formatTime, fromInputs, layoutDay, monthGrid, sameDay, startOfDay, startOfWeek, timeInput, weekdayName, type Item } from './model'
import { parseQuickAdd } from './quickadd'
import { describeRepeat } from './recur'
import { appleStore, eventsStore, loadApple, refreshEvents, useItems } from './state'

type View = 'month' | 'week' | 'day'
type Editing = { draft: CalEvent; original: CalEvent | null; occurrence: number | null }

const HOUR = 44
const REMINDERS: Array<[number | null, string]> = [[null, 'No reminder'], [0, 'At the start'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before']]

function blankEvent(start: number, allDay: boolean, reminder: number | null): CalEvent {
  return { id: newId(), title: '', start, end: allDay ? addDays(start, 1) : start + 3_600_000, allDay, location: '', notes: '', color: 'blue', repeat: null, skip: [], reminder: allDay ? null : reminder, updated: 0, by: '', deleted: false, seq: 0 }
}

export default function CalendarPage({ active }: { active: boolean }) {
  const config = useConfig()
  const weekStart = config.calendar.weekStart
  const [view, setView] = useState<View>('week')
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()))
  const [editing, setEditing] = useState<Editing | null>(null)
  const [viewing, setViewing] = useState<Item | null>(null)
  const [quick, setQuick] = useState('')
  const [status, setStatus] = useState<{ text: string; event?: CalEvent } | null>(null)
  const apple = useStore(appleStore)

  const [from, to] = useMemo(() => {
    if (view === 'day') return [anchor, addDays(anchor, 1)]
    if (view === 'week') { const s = startOfWeek(anchor, weekStart); return [s, addDays(s, 7)] }
    const grid = monthGrid(anchor, weekStart)
    return [grid[0], addDays(grid[41], 1)]
  }, [view, anchor, weekStart])
  const items = useItems(from, to)

  const step = (dir: number) => setAnchor(a => view === 'day' ? addDays(a, dir) : view === 'week' ? addDays(a, 7 * dir) : startOfDay(addMonths(a, dir)))
  const title = view === 'month'
    ? new Date(anchor).toLocaleDateString([], { month: 'long', year: 'numeric' })
    : view === 'week'
      ? (() => { const s = startOfWeek(anchor, weekStart); const e = addDays(s, 6); return `${new Date(s).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(e).toLocaleDateString([], { month: new Date(s).getMonth() === new Date(e).getMonth() ? undefined : 'short', day: 'numeric', year: 'numeric' })}` })()
      : new Date(anchor).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || editing || viewing || (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return
      if (e.key === 't') setAnchor(startOfDay(Date.now()))
      else if (e.key === 'ArrowLeft' || e.key === 'j') step(-1)
      else if (e.key === 'ArrowRight' || e.key === 'k') step(1)
      else if (e.key === 'm') setView('month')
      else if (e.key === 'w') setView('week')
      else if (e.key === 'd') setView('day')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function open(item: Item) {
    if (item.source === 'event' && item.event) setEditing({ draft: item.event.repeat ? { ...item.event } : item.event, original: item.event, occurrence: item.event.repeat ? item.start : null })
    else setViewing(item)
  }

  async function addQuick() {
    if (!quick.trim()) return
    const parsed = parseQuickAdd(quick)
    const event = { ...blankEvent(parsed.start, parsed.allDay, config.calendar.defaultReminder), ...parsed }
    try {
      const saved = await calendarSave(event)
      eventsStore.set(list => [...list.filter(e => e.id !== saved.id), saved])
      setQuick('')
      setAnchor(startOfDay(saved.start))
      setStatus({ text: `Added “${saved.title}” · ${new Date(saved.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${saved.allDay ? '' : ` ${formatTime(saved.start)}`}${saved.repeat ? ` · ${describeRepeat(saved)}` : ''}`, event: saved })
    } catch (error) { setStatus({ text: String(error) }) }
  }

  async function importIcs() {
    try {
      const path = await pickIcsFile('open')
      if (!path) return
      const events = fromIcs(await calendarReadIcs(path))
      if (!events.length) { setStatus({ text: 'No events found in that file.' }); return }
      const count = await calendarImport(events)
      await refreshEvents()
      setStatus({ text: `Imported ${count} event${count === 1 ? '' : 's'}.` })
    } catch (error) { setStatus({ text: String(error) }) }
  }

  async function exportIcs() {
    try {
      const path = await pickIcsFile('save', 'BridgeDeck calendar.ics')
      if (!path) return
      const events = eventsStore.get().filter(e => !e.deleted)
      await calendarWriteIcs(path, toIcs(events))
      setStatus({ text: `Saved ${events.length} event${events.length === 1 ? '' : 's'} as ${path.split(/[\\/]/).pop()}.` })
    } catch (error) { setStatus({ text: String(error) }) }
  }

  return <div className="cal-page">
    <div className="cal-header">
      <div className="cal-nav">
        <button className="ghost" onClick={() => setAnchor(startOfDay(Date.now()))}>Today</button>
        <button className="cal-icon" title="Previous" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button className="cal-icon" title="Next" onClick={() => step(1)}><ChevronRight size={16} /></button>
        <h2>{title}</h2>
      </div>
      <div className="cal-views">
        {(['day', 'week', 'month'] as View[]).map(v => <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
      </div>
    </div>
    <div className="cal-toolbar">
      <form className="cal-quick" onSubmit={e => { e.preventDefault(); void addQuick() }}>
        <CalendarPlus size={15} />
        <input value={quick} onChange={e => setQuick(e.target.value)} placeholder="Quick add: “Lunch with Sam tomorrow 1pm”, “Gym every mon wed fri 7am”" />
      </form>
      <button className="cal-icon" title="New event" onClick={() => setEditing({ draft: blankEvent(anchor + 9 * 3_600_000, false, config.calendar.defaultReminder), original: null, occurrence: null })}><CalendarPlus size={16} /></button>
      <button className="cal-icon" title="Import an .ics file" onClick={() => void importIcs()}><Upload size={16} /></button>
      <button className="cal-icon" title="Export as an .ics file" onClick={() => void exportIcs()}><Download size={16} /></button>
      {config.calendar.showApple && <button className="cal-icon" title="Reload Apple Calendar" onClick={() => void loadApple(from, to, true)}><RefreshCw size={15} className={apple.loading ? 'spin' : ''} /></button>}
    </div>
    {status && <div className="cal-status"><span>{status.text}</span>{status.event && <button className="ghost" onClick={() => { setEditing({ draft: status.event!, original: status.event!, occurrence: null }); setStatus(null) }}>Edit</button>}<button className="cal-icon" title="Close" onClick={() => setStatus(null)}><X size={13} /></button></div>}
    {config.calendar.showApple && apple.errors.map(error => <p key={error} className="cal-error">{error}</p>)}
    {view === 'month'
      ? <MonthView anchor={anchor} weekStart={weekStart} items={items} onOpen={open} onDay={day => { setAnchor(day); setView('day') }}
          onNew={day => setEditing({ draft: blankEvent(day + 9 * 3_600_000, false, config.calendar.defaultReminder), original: null, occurrence: null })} />
      : <TimeGrid days={view === 'day' ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor, weekStart), i))} items={items} onOpen={open}
          onDay={day => { setAnchor(day); setView('day') }}
          onNew={(start, allDay) => setEditing({ draft: blankEvent(start, allDay, config.calendar.defaultReminder), original: null, occurrence: null })} />}
    {editing && <EventEditor editing={editing} onClose={() => setEditing(null)} onStatus={text => setStatus({ text })} />}
    {viewing && <ItemDetails item={viewing} onClose={() => setViewing(null)} />}
  </div>
}

function Chip({ item, onOpen, compact = false }: { item: Item; onOpen: (item: Item) => void; compact?: boolean }) {
  const color = colorOf(item.color)
  return <button className={`cal-chip source-${item.source}${item.allDay ? ' all-day' : ''}`} style={{ ['--chip' as string]: color }} title={`${item.title}\n${formatRange(item)}${item.calendar ? `\n${item.calendar}` : ''}`}
    onClick={e => { e.stopPropagation(); onOpen(item) }}>
    {item.source === 'todo' && <ListChecks size={11} />}
    {!item.allDay && !compact && <span className="cal-chip-time">{formatTime(item.start)}</span>}
    <span className="cal-chip-title">{item.title}</span>
  </button>
}

function MonthView({ anchor, weekStart, items, onOpen, onDay, onNew }: { anchor: number; weekStart: number; items: Item[]; onOpen: (item: Item) => void; onDay: (day: number) => void; onNew: (day: number) => void }) {
  const grid = monthGrid(anchor, weekStart)
  const month = new Date(anchor).getMonth()
  const today = startOfDay(Date.now())
  return <div className="card cal-month">
    {grid.slice(0, 7).map(day => <div key={`h${day}`} className="cal-month-head">{weekdayName(new Date(day).getDay(), true)}</div>)}
    {grid.map(day => {
      const here = items.filter(item => touchesDay(item, day))
      return <div key={day} className={`cal-month-cell${new Date(day).getMonth() !== month ? ' other' : ''}${day === today ? ' today' : ''}`} onDoubleClick={() => onNew(day)}>
        <button className="cal-day-number" onClick={() => onDay(day)}>{new Date(day).getDate()}</button>
        {here.slice(0, 3).map(item => <Chip key={item.key} item={item} onOpen={onOpen} />)}
        {here.length > 3 && <button className="cal-more" onClick={() => onDay(day)}>+{here.length - 3} more</button>}
      </div>
    })}
  </div>
}

function TimeGrid({ days, items, onOpen, onNew, onDay }: { days: number[]; items: Item[]; onOpen: (item: Item) => void; onNew: (start: number, allDay: boolean) => void; onDay: (day: number) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR }, [])
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(t) }, [])
  const today = startOfDay(now)
  const columns = `52px repeat(${days.length}, minmax(0, 1fr))`
  return <div className="card cal-grid">
    <div className="cal-grid-head" style={{ gridTemplateColumns: columns }}>
      <div />
      {days.map(day => <button key={day} className={`cal-col-head${day === today ? ' today' : ''}`} onClick={() => onDay(day)}>
        <span>{weekdayName(new Date(day).getDay(), true)}</span><strong>{new Date(day).getDate()}</strong>
      </button>)}
    </div>
    <div className="cal-allday" style={{ gridTemplateColumns: columns }}>
      <div className="cal-allday-label">all-day</div>
      {days.map(day => <div key={day} className="cal-allday-cell" onDoubleClick={() => onNew(day, true)}>
        {items.filter(item => (item.allDay || item.end - item.start >= DAY) && touchesDay(item, day)).map(item => <Chip key={item.key} item={item} onOpen={onOpen} compact />)}
      </div>)}
    </div>
    <div className="cal-scroll" ref={scroller}>
      <div className="cal-body" style={{ gridTemplateColumns: columns, height: 24 * HOUR }}>
        <div className="cal-hours">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h === 0 ? '' : new Date(2020, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</span>)}</div>
        {days.map(day => {
          const timed = items.filter(item => !item.allDay && item.end - item.start < DAY && touchesDay(item, day))
          return <div key={day} className="cal-day-col" onClick={e => {
            const y = e.clientY - e.currentTarget.getBoundingClientRect().top
            const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor(y / HOUR * 2) * 30))
            const start = new Date(day)
            start.setHours(0, minutes, 0, 0)
            onNew(start.getTime(), false)
          }}>
            {Array.from({ length: 24 }, (_, h) => <i key={h} className="cal-hour-line" style={{ top: h * HOUR }} />)}
            {layoutDay(timed).map(({ item, column, columns: count }) => {
              const start = Math.max(item.start, day)
              const end = Math.min(Math.max(item.end, item.start + 20 * 60_000), addDays(day, 1))
              const top = (start - day) / 3_600_000 * HOUR
              const height = Math.max(18, (end - start) / 3_600_000 * HOUR - 2)
              return <button key={item.key} className={`cal-block source-${item.source}`} style={{ top, height, left: `calc(${column / count * 100}% + 2px)`, width: `calc(${100 / count}% - 4px)`, ['--chip' as string]: colorOf(item.color) }}
                onClick={e => { e.stopPropagation(); onOpen(item) }} title={`${item.title}\n${formatRange(item)}`}>
                <strong>{item.source === 'todo' && <ListChecks size={11} />} {item.title}</strong>
                {height > 30 && <span>{formatRange(item)}</span>}
                {height > 46 && item.event?.location && <span>{item.event.location}</span>}
              </button>
            })}
            {sameDay(day, now) && <div className="cal-now" style={{ top: (now - day) / 3_600_000 * HOUR }} />}
          </div>
        })}
      </div>
    </div>
  </div>
}

function ItemDetails({ item, onClose }: { item: Item; onClose: () => void }) {
  return <div className="cal-modal-back" onClick={onClose}>
    <div className="card cal-modal small" onClick={e => e.stopPropagation()}>
      <div className="cal-modal-head"><h3>{item.title}</h3><button className="cal-icon" onClick={onClose}><X size={15} /></button></div>
      <p>{new Date(item.start).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · {formatRange(item)}</p>
      {item.calendar && <p className="cal-muted">{item.source === 'todo' ? `Checklist: ${item.calendar}` : item.source === 'canvas' ? `Canvas: ${item.calendar}` : `Apple Calendar: ${item.calendar}`}</p>}
      {item.source === 'canvas' && <p className="cal-muted">{item.checked ? 'Done. ' : ''}From Canvas. Mark it done in the Study tab’s Assignments.</p>}
      {item.source === 'canvas' && <div className="actions">{item.url && <button onClick={() => { openInNewTab(item.url!); onClose() }}><ExternalLink size={15} />Open in Canvas</button>}<button className="secondary" onClick={() => { activateTab('study'); onClose() }}><GraduationCap size={15} />Study</button></div>}
      {item.source === 'apple' && <p className="cal-muted">Shown from the Mac’s Apple Calendar. Change it there.</p>}
      {item.source === 'todo' && <div className="actions"><button onClick={() => { activateTab('notes'); onClose() }}><ListChecks size={15} />Open in Notes</button></div>}
    </div>
  </div>
}

const REPEATS: Array<[string, string]> = [['none', 'Doesn’t repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']]

function repeatKind(r: CalRepeat | null) {
  if (!r) return 'none'
  if (r.freq === 'weekly' && r.days.length === 5 && [1, 2, 3, 4, 5].every(d => r.days.includes(d))) return 'weekdays'
  return r.freq
}

function EventEditor({ editing, onClose, onStatus }: { editing: Editing; onClose: () => void; onStatus: (text: string) => void }) {
  const config = useConfig()
  // An occurrence of a repeating event opens at that occurrence's time.
  const shift = editing.occurrence !== null ? editing.occurrence - editing.draft.start : 0
  const [draft, setDraft] = useState<CalEvent>({ ...editing.draft, start: editing.draft.start + shift, end: editing.draft.end + shift })
  const [error, setError] = useState('')
  const series = editing.original?.repeat ? editing.original : null
  const set = (changes: Partial<CalEvent>) => setDraft(d => ({ ...d, ...changes }))
  const length = Math.max(0, draft.end - draft.start)
  const kind = repeatKind(draft.repeat)
  const ends = draft.repeat?.count ? 'count' : draft.repeat?.until ? 'until' : 'never'

  function setRepeat(next: string) {
    if (next === 'none') return set({ repeat: null })
    const base = { interval: draft.repeat?.interval ?? 1, until: draft.repeat?.until ?? null, count: draft.repeat?.count ?? null }
    if (next === 'weekdays') return set({ repeat: { ...base, interval: 1, freq: 'weekly', days: [1, 2, 3, 4, 5] } })
    set({ repeat: { ...base, freq: next as CalRepeat['freq'], days: next === 'weekly' ? [new Date(draft.start).getDay()] : [] } })
  }

  async function persist(event: CalEvent) {
    const saved = await calendarSave(event)
    eventsStore.set(list => [...list.filter(e => e.id !== saved.id), saved])
    return saved
  }

  async function save(onlyThis: boolean) {
    setError('')
    if (draft.end < draft.start) { setError('It ends before it starts.'); return }
    try {
      if (series && onlyThis && editing.occurrence !== null) {
        // This occurrence becomes its own event; the series skips it.
        await persist({ ...series, skip: [...series.skip, editing.occurrence] })
        await persist({ ...draft, id: newId(), repeat: null, skip: [] })
      } else if (series && editing.occurrence !== null) {
        // The whole series moves by however much this occurrence moved.
        const moved = draft.start - editing.occurrence
        await persist({ ...draft, start: series.start + moved, end: series.start + moved + length, skip: moved ? [] : series.skip })
      } else {
        await persist(draft)
      }
      onClose()
    } catch (e) { setError(String(e)) }
  }

  async function remove(onlyThis: boolean) {
    try {
      if (series && onlyThis && editing.occurrence !== null) await persist({ ...series, skip: [...series.skip, editing.occurrence] })
      else if (editing.original) {
        await calendarDelete(editing.original.id)
        eventsStore.set(list => list.filter(e => e.id !== editing.original!.id))
      }
      onStatus(onlyThis ? 'Removed that occurrence.' : `Deleted “${draft.title || 'Untitled event'}”.`)
      onClose()
    } catch (e) { setError(String(e)) }
  }

  return <div className="cal-modal-back" onClick={onClose}>
    <form className="card cal-modal" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void save(false) }}
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
      <div className="cal-modal-head">
        <input className="cal-title-input" autoFocus placeholder="Event title" value={draft.title} onChange={e => set({ title: e.target.value })} />
        <button type="button" className="cal-icon" onClick={onClose}><X size={15} /></button>
      </div>
      <label className="cal-check"><input type="checkbox" checked={draft.allDay} onChange={e => {
        const allDay = e.target.checked
        const day = startOfDay(draft.start)
        set(allDay ? { allDay, start: day, end: addDays(day, Math.max(1, Math.round((startOfDay(draft.end - 1) - day) / DAY) + 1)), reminder: null }
          : { allDay, start: day + 9 * 3_600_000, end: day + 10 * 3_600_000, reminder: config.calendar.defaultReminder })
      }} />All day</label>
      <div className="cal-when">
        <input type="date" value={dateInput(draft.start)} onChange={e => { if (!e.target.value) return; const start = fromInputs(e.target.value, draft.allDay ? '00:00' : timeInput(draft.start)); set({ start, end: start + length }) }} />
        {!draft.allDay && <input type="time" value={timeInput(draft.start)} onChange={e => { if (!e.target.value) return; const start = fromInputs(dateInput(draft.start), e.target.value); set({ start, end: start + length }) }} />}
        <span>to</span>
        <input type="date" value={dateInput(draft.allDay ? draft.end - 1 : draft.end)} onChange={e => { if (!e.target.value) return; set({ end: draft.allDay ? addDays(fromInputs(e.target.value, '00:00'), 1) : fromInputs(e.target.value, timeInput(draft.end)) }) }} />
        {!draft.allDay && <input type="time" value={timeInput(draft.end)} onChange={e => { if (!e.target.value) return; set({ end: fromInputs(dateInput(draft.end), e.target.value) }) }} />}
      </div>
      <div className="cal-row">
        <Repeat size={14} />
        <select value={kind} onChange={e => setRepeat(e.target.value)}>{REPEATS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
        {draft.repeat && kind !== 'weekdays' && <label className="cal-inline">every <input type="number" min={1} max={99} value={draft.repeat.interval} onChange={e => set({ repeat: { ...draft.repeat!, interval: Math.max(1, Number(e.target.value) || 1) } })} /> {({ daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' })[draft.repeat.freq]}</label>}
      </div>
      {draft.repeat?.freq === 'weekly' && kind !== 'weekdays' && <div className="cal-weekdays">
        {[0, 1, 2, 3, 4, 5, 6].map(d => <button type="button" key={d} className={draft.repeat!.days.includes(d) ? 'active' : ''} onClick={() => {
          const days = draft.repeat!.days.includes(d) ? draft.repeat!.days.filter(x => x !== d) : [...draft.repeat!.days, d].sort()
          set({ repeat: { ...draft.repeat!, days: days.length ? days : [new Date(draft.start).getDay()] } })
        }}>{weekdayName(d, true).slice(0, 2)}</button>)}
      </div>}
      {draft.repeat && <div className="cal-row">
        <span className="cal-muted">Ends</span>
        <select value={ends} onChange={e => set({ repeat: { ...draft.repeat!, until: e.target.value === 'until' ? addDays(startOfDay(draft.start), 30) + DAY - 1 : null, count: e.target.value === 'count' ? 10 : null } })}>
          <option value="never">Never</option><option value="until">On a date</option><option value="count">After a number of times</option>
        </select>
        {ends === 'until' && <input type="date" value={dateInput(draft.repeat.until!)} onChange={e => { if (e.target.value) set({ repeat: { ...draft.repeat!, until: fromInputs(e.target.value, '23:59') + 59_999 } }) }} />}
        {ends === 'count' && <label className="cal-inline"><input type="number" min={1} max={999} value={draft.repeat.count!} onChange={e => set({ repeat: { ...draft.repeat!, count: Math.max(1, Number(e.target.value) || 1) } })} /> times</label>}
      </div>}
      <div className="cal-row">
        <select value={draft.reminder ?? ''} onChange={e => set({ reminder: e.target.value === '' ? null : Number(e.target.value) })}>
          {REMINDERS.map(([v, label]) => <option key={String(v)} value={v ?? ''}>{label}</option>)}
        </select>
        <div className="cal-colors">{COLORS.map(([name, hex]) => <button type="button" key={name} title={name} className={draft.color === name ? 'active' : ''} style={{ background: hex }} onClick={() => set({ color: name })} />)}</div>
      </div>
      <label className="cal-field"><MapPin size={14} /><input placeholder="Location" value={draft.location} onChange={e => set({ location: e.target.value })} /></label>
      <textarea className="cal-notes" placeholder="Notes" value={draft.notes} onChange={e => set({ notes: e.target.value })} rows={3} />
      {error && <p className="cal-error">{error}</p>}
      <div className="cal-modal-actions">
        {editing.original && <>
          {series && <button type="button" className="danger" onClick={() => void remove(true)}><Trash2 size={14} />Delete this one</button>}
          <button type="button" className="danger" onClick={() => void remove(false)}><Trash2 size={14} />{series ? 'Delete all' : 'Delete'}</button>
        </>}
        <span className="grow" />
        {series && <button type="button" className="ghost" onClick={() => void save(true)}>Save this one only</button>}
        <button type="submit" className="cal-primary">{series ? 'Save all' : 'Save'}</button>
      </div>
    </form>
  </div>
}
