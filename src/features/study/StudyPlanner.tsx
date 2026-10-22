import { useMemo, useState } from 'react'
import { CalendarPlus, CalendarRange, Plus, Trash2 } from 'lucide-react'
import { calendarDelete, calendarSave, isTauri, type CalEvent } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { eventsStore, useItems } from '../calendar/state'
import { DAY, dateInput, formatTime, fromInputs, startOfDay } from '../calendar/model'
import { newId } from '../notes/model'
import { useAssignments, useExams } from './assignments'
import { DEFAULT_PLAN, guessHours, PLAN_TAG, planStudy, type PlanOptions, type StudyTask } from './planner'

const PREFS_KEY = 'bridgedeck.study.planner'
type Prefs = { options: PlanOptions; hours: Record<string, number>; skip: string[]; extra: StudyTask[] }
const readPrefs = (): Prefs => {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>; return { options: { ...DEFAULT_PLAN, ...p.options }, hours: p.hours ?? {}, skip: p.skip ?? [], extra: p.extra ?? [] } } catch { return { options: DEFAULT_PLAN, hours: {}, skip: [], extra: [] } }
}
const HORIZON = 28 * DAY
const dayText = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

/** The study planner: what's due in the next four weeks, how long each needs, and study blocks in
 *  the free time before each, added to the calendar in one go. */
export function StudyPlanner() {
  const [prefs, setPrefsState] = useState(readPrefs)
  const setPrefs = (next: Prefs) => { setPrefsState(next); try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* this run only */ } }
  const [now] = useState(() => Date.now())
  const [status, setStatus] = useState('')
  const [busyAdding, setBusyAdding] = useState(false)
  const [adding, setAdding] = useState({ title: '', date: dateInput(now + 7 * DAY), hours: 4 })
  const events = useStore(eventsStore)
  const assignments = useAssignments()
  const exams = useExams()
  const tasks: StudyTask[] = useMemo(() => [
    ...assignments.filter(a => !a.done && !a.submitted && a.due && a.due > now && a.due < now + HORIZON).map(a => ({ id: a.id, title: a.title, course: a.course, due: a.due!, hours: prefs.hours[a.id] ?? guessHours(a.kind, a.title) })),
    ...prefs.extra.filter(t => t.due > now),
    // Exams (from the calendar and Canvas) get study time before them too.
    ...exams.filter(e => e.source === 'calendar' && e.start > now && e.start < now + HORIZON).map(e => ({ id: e.id, title: `${e.course} ${e.title}`, course: e.course, due: e.start, hours: prefs.hours[e.id] ?? 6 })),
  ].sort((a, b) => a.due - b.due), [assignments, prefs, now, exams])
  const chosen = tasks.filter(t => !prefs.skip.includes(t.id) && t.hours > 0)
  const last = Math.max(now + DAY, ...chosen.map(t => t.due))
  const items = useItems(startOfDay(now), last + DAY)
  // Busy: anything timed on the calendar (classes, events), except this planner's own blocks.
  const busy = useMemo(() => items.filter(i => !i.allDay && i.source !== 'canvas' && i.source !== 'todo' && !i.event?.notes.includes(PLAN_TAG)), [items])
  const plan = useMemo(() => planStudy(chosen, busy, prefs.options, now), [chosen, busy, prefs.options, now])
  const old = events.filter(e => !e.deleted && e.notes.includes(PLAN_TAG) && e.start > now)
  const byDay = useMemo(() => {
    const m = new Map<number, typeof plan.blocks>()
    for (const b of plan.blocks) m.set(startOfDay(b.start), [...(m.get(startOfDay(b.start)) ?? []), b])
    return [...m.entries()]
  }, [plan])
  const opt = (patch: Partial<PlanOptions>) => setPrefs({ ...prefs, options: { ...prefs.options, ...patch } })

  async function addToCalendar() {
    if (!plan.blocks.length) return
    if (old.length && !window.confirm(`Replace the ${old.length} study block${old.length === 1 ? '' : 's'} from your last plan with these ${plan.blocks.length}?`)) return
    setBusyAdding(true); setStatus('')
    try {
      for (const e of old) await calendarDelete(e.id)
      const saved: CalEvent[] = []
      for (const b of plan.blocks) {
        const t = chosen.find(x => x.id === b.task)
        saved.push(await calendarSave({ id: newId(), title: `Study: ${b.title}`, start: b.start, end: b.end, allDay: false, location: '', notes: `${t?.course ? `${t.course} · ` : ''}due ${t ? `${dayText(t.due)} ${formatTime(t.due)}` : ''}\n${PLAN_TAG}`, color: 'purple', repeat: null, skip: [], reminder: 10, updated: 0, by: '', deleted: false, seq: 0 }))
      }
      const gone = new Set(old.map(e => e.id))
      eventsStore.set(list => [...list.filter(e => !gone.has(e.id) && !saved.some(s => s.id === e.id)), ...saved])
      setStatus(`Added ${saved.length} study block${saved.length === 1 ? '' : 's'} to your calendar${old.length ? ` (replacing ${old.length})` : ''}.`)
    } catch (e) { setStatus(errorText(e, 'Couldn’t add them')) } finally { setBusyAdding(false) }
  }

  return <div className="study-course study-planner">
    <Card>
      <SectionTitle title="Study planner" subtitle="Study time for what's due in the next four weeks, fitted around your classes and calendar" />
      <div className="planner-options">
        <label>Study from <select value={prefs.options.fromHour} onChange={e => opt({ fromHour: Number(e.target.value) })}>{Array.from({ length: 16 }, (_, h) => h + 6).map(h => <option key={h} value={h}>{formatTime(new Date(2026, 0, 1, h).getTime())}</option>)}</select></label>
        <label>to <select value={prefs.options.toHour} onChange={e => opt({ toHour: Number(e.target.value) })}>{Array.from({ length: 12 }, (_, h) => h + 13).map(h => <option key={h} value={h}>{h === 24 ? 'midnight' : formatTime(new Date(2026, 0, 1, h).getTime())}</option>)}</select></label>
        <label>At most <select value={prefs.options.maxPerDay} onChange={e => opt({ maxPerDay: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 8].map(h => <option key={h} value={h}>{h} h a day</option>)}</select></label>
        <label>Blocks of <select value={prefs.options.blockMinutes} onChange={e => opt({ blockMinutes: Number(e.target.value) })}>{[30, 45, 60, 90, 120].map(m => <option key={m} value={m}>{m} min</option>)}</select></label>
      </div>
      <table className="planner-tasks">
        <thead><tr><th /><th>Due</th><th>What</th><th>Hours</th><th /></tr></thead>
        <tbody>
          {tasks.map(t => { const off = prefs.skip.includes(t.id); const extra = prefs.extra.some(x => x.id === t.id); return <tr key={t.id} className={off ? 'off' : undefined}>
            <td><input type="checkbox" checked={!off} onChange={() => setPrefs({ ...prefs, skip: off ? prefs.skip.filter(x => x !== t.id) : [...prefs.skip, t.id] })} aria-label="Plan for this" /></td>
            <td>{dayText(t.due)}</td>
            <td>{t.course && <small>{t.course}</small>} {t.title}{plan.short[t.id] ? <em className="planner-short"> {plan.short[t.id]} h didn’t fit</em> : null}</td>
            <td><input type="number" min={0} max={40} step={0.5} value={t.hours} onChange={e => { const h = Math.max(0, Number(e.target.value) || 0); setPrefs(extra ? { ...prefs, extra: prefs.extra.map(x => (x.id === t.id ? { ...x, hours: h } : x)) } : { ...prefs, hours: { ...prefs.hours, [t.id]: h } }) }} /></td>
            <td>{extra && <button className="ghost" title="Remove" onClick={() => setPrefs({ ...prefs, extra: prefs.extra.filter(x => x.id !== t.id) })}><Trash2 size={12} /></button>}</td>
          </tr> })}
          {!tasks.length && <tr><td colSpan={5} className="hint">Nothing due in the next four weeks. Add an exam or assignment below (or connect Canvas in Settings).</td></tr>}
        </tbody>
      </table>
      <form className="planner-add" onSubmit={e => { e.preventDefault(); if (!adding.title.trim()) return; setPrefs({ ...prefs, extra: [...prefs.extra, { id: `x${Date.now().toString(36)}`, title: adding.title.trim(), course: '', due: fromInputs(adding.date, '09:00'), hours: adding.hours }] }); setAdding({ ...adding, title: '' }) }}>
        <input placeholder="Add an exam or deadline, e.g. Physics midterm" value={adding.title} onChange={e => setAdding({ ...adding, title: e.target.value })} />
        <input type="date" value={adding.date} onChange={e => setAdding({ ...adding, date: e.target.value })} aria-label="Due" />
        <input type="number" min={0.5} max={40} step={0.5} value={adding.hours} onChange={e => setAdding({ ...adding, hours: Number(e.target.value) || 1 })} aria-label="Hours" title="Hours it needs" />
        <button className="ghost" disabled={!adding.title.trim()}><Plus size={13} /> Add</button>
      </form>
    </Card>
    <Card>
      <SectionTitle title={`The plan: ${plan.blocks.length} block${plan.blocks.length === 1 ? '' : 's'}`} subtitle={plan.blocks.length ? `${(plan.blocks.reduce((n, b) => n + b.end - b.start, 0) / 3_600_000).toFixed(1)} hours over ${byDay.length} day${byDay.length === 1 ? '' : 's'}` : 'Set the hours above'} />
      <div className="planner-days">
        {byDay.map(([day, blocks]) => <div key={day} className="planner-day">
          <strong>{dayText(day)}</strong>
          {blocks.map(b => <div key={b.start} className="planner-block"><span>{formatTime(b.start)}–{formatTime(b.end)}</span>{b.title}</div>)}
        </div>)}
      </div>
      <div className="actions">
        <button className="primary" disabled={!plan.blocks.length || busyAdding || !isTauri()} onClick={() => void addToCalendar()}><CalendarPlus size={14} /> {old.length ? 'Replace the plan in Calendar' : 'Add to Calendar'}</button>
        {old.length > 0 && <span className="hint"><CalendarRange size={12} /> {old.length} block{old.length === 1 ? '' : 's'} from your last plan are in the calendar.</span>}
      </div>
      {status && <p className="hint">{status}</p>}
    </Card>
  </div>
}
