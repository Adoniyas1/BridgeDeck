import { useEffect, useMemo } from 'react'
import { BellRing, Brain, CalendarClock, Layers, X } from 'lucide-react'
import { bridgeLinkStore } from '../../core/bridgelink'
import { configStore, setConfig, useConfig } from '../../core/config'
import { notify } from '../../core/notify'
import { createStore, useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle, Toggle } from '../../ui'
import { eventsLoadedStore, eventsStore } from '../calendar/state'
import { transfersStore } from '../files/state'
import { notesLoadedStore, notesStore, openNoteRequest } from '../notes/state'
import { projectsStore, refreshProjects } from '../projects/state'
import { allAssignments } from '../study/assignments'
import { libraryStore, refreshLibrary, reviewAllRequest } from '../study/state'
import { awayIsEmpty, briefLine, buildBrief, dailyDue, eveningNudge, whileAway, type Away } from './brief'

/** "While you were away", shown on Home until dismissed. */
export const awayStore = createStore<Away | null>(null)
const AWAY_AFTER = 3 * 3_600_000

function remembered(key: string) {
  try { return localStorage.getItem(key) ?? '' } catch { return '' }
}
function remember(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private window: not remembered */ }
}

function currentBrief(now = Date.now()) {
  return buildBrief({
    now, events: eventsStore.get(), notes: notesStore.get(),
    courses: libraryStore.get().library?.courses.map(c => c.name) ?? [],
    projects: projectsStore.get().list?.projects.map(p => p.name) ?? [],
    canvas: allAssignments().filter(a => a.source === 'canvas' && !a.done),
  })
}

/** The morning brief and evening nudge notifications, and noticing a return after a while away. */
export function BriefBackground() {
  useEffect(() => {
    // Course and project names tell exams and milestones apart from other events.
    void refreshLibrary(); void refreshProjects()
    const names = window.setInterval(() => { void refreshLibrary(); void refreshProjects() }, 10 * 60_000)
    const tick = () => {
      const now = Date.now()
      const { brief: settings } = configStore.get()
      const loaded = notesLoadedStore.get() && eventsLoadedStore.get()
      if (loaded && settings.morning && dailyDue(settings.morningAt, now, remembered('bd-brief-morning'))) {
        remember('bd-brief-morning', new Date(now).toDateString())
        notify('reminders', 'Good morning', briefLine(currentBrief(now)))
      }
      if (loaded && settings.evening && dailyDue(settings.eveningAt, now, remembered('bd-brief-evening'))) {
        remember('bd-brief-evening', new Date(now).toDateString())
        const nudge = eveningNudge(currentBrief(now))
        if (nudge) notify('reminders', 'Study check-in', nudge)
      }
      if (loaded && document.visibilityState === 'visible' && document.hasFocus()) {
        const last = Number(remembered('bd-last-seen')) || 0
        if (settings.away && last && now - last > AWAY_AFTER) {
          const away = whileAway(last, bridgeLinkStore.get().instanceId, notesStore.get(), eventsStore.get(), transfersStore.get())
          if (!awayIsEmpty(away)) awayStore.set(away)
        }
        remember('bd-last-seen', String(now))
      }
    }
    const timer = window.setInterval(tick, 30_000)
    window.addEventListener('focus', tick)
    const first = window.setTimeout(tick, 4000)
    return () => { window.clearInterval(timer); window.clearInterval(names); window.clearTimeout(first); window.removeEventListener('focus', tick) }
  }, [])
  return null
}

const when = (days: number) => days <= 1 ? 'tomorrow' : `in ${days} days`

/** Coming up (exams, milestones) and flashcards to review, next to Today on Home. */
export function BriefCard() {
  const events = useStore(eventsStore)
  const notes = useStore(notesStore)
  const library = useStore(libraryStore)
  const projects = useStore(projectsStore)
  const brief = useMemo(() => currentBrief(), [events, notes, library, projects])
  if (!brief.soon.length && !brief.cards.length) return null
  return <Card className="agenda-card"><SectionTitle title="Coming up" subtitle="Exams, milestones and reviews" action={<CalendarClock size={18} />} />
    <div className="agenda-list">
      {brief.soon.slice(0, 5).map(s => <button key={`${s.title}${s.start}`} className="agenda-row" onClick={() => activateTab(s.kind === 'exam' ? 'study' : 'projects')}>
        <i style={{ background: s.kind === 'exam' ? '#f07178' : '#c792ea' }} /><span className="agenda-time">{when(s.days)}</span><span className="grow agenda-title">{s.title}</span></button>)}
      {brief.cards.length > 1 && <button className="agenda-row" onClick={() => { reviewAllRequest.set(Date.now()); activateTab('study') }}>
        <Brain size={13} /><span className="agenda-time">{brief.cards.reduce((n, c) => n + c.due, 0)} cards</span><span className="grow agenda-title">Review all courses, mixed</span></button>}
      {brief.cards.map(c => <button key={c.course} className="agenda-row" onClick={() => activateTab('study')}>
        <Layers size={13} /><span className="agenda-time">{c.due} card{c.due === 1 ? '' : 's'}</span><span className="grow agenda-title">Review {c.course}</span></button>)}
    </div>
  </Card>
}

export function AwayCard() {
  const away = useStore(awayStore)
  if (!away) return null
  const hours = Math.round((Date.now() - away.since) / 3_600_000)
  return <Card className="incoming-card"><SectionTitle title="While you were away" subtitle={`Since ${hours < 48 ? `${hours} hours ago` : new Date(away.since).toLocaleDateString()}, from your other computer`}
    action={<button className="cal-icon" title="Dismiss" onClick={() => awayStore.set(null)}><X size={15} /></button>} />
    <div className="agenda-list">
      {away.notes.slice(0, 6).map(n => <button key={n.id} className="agenda-row" onClick={() => { openNoteRequest.set(n.id); activateTab('notes') }}>
        <i style={{ background: '#82aaff' }} /><span className="agenda-time">{n.changes} edit{n.changes === 1 ? '' : 's'}</span><span className="grow agenda-title">{n.title}</span></button>)}
      {away.events.slice(0, 4).map(e => <button key={e.title + e.start} className="agenda-row" onClick={() => activateTab('calendar')}>
        <i style={{ background: '#4fc98a' }} /><span className="agenda-time">{new Date(e.start).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><span className="grow agenda-title">New: {e.title}</span></button>)}
      {away.files.slice(0, 4).map((f, i) => <button key={i} className="agenda-row" onClick={() => activateTab('files')}>
        <i style={{ background: '#f5a454' }} /><span className="agenda-time">from {f.from}</span><span className="grow agenda-title">{f.names.slice(0, 3).join(', ')}{f.names.length > 3 ? ` +${f.names.length - 3}` : ''}</span></button>)}
    </div>
  </Card>
}

/** Settings for the brief, nudges and "while you were away". */
export function BriefSettings() {
  const { brief } = useConfig()
  const set = (patch: Partial<typeof brief>) => setConfig(c => ({ ...c, brief: { ...c.brief, ...patch } }))
  return <Card><SectionTitle title="Check-ins" subtitle="BridgeDeck tells you what's coming, from your calendar, checklists and flashcards" action={<BellRing size={18} />} />
    <div className="brief-row"><Toggle checked={brief.morning} onChange={morning => set({ morning })} label="Morning brief: today's events, what's due, exams coming up, cards to review" /><input type="time" value={brief.morningAt} onChange={e => set({ morningAt: e.target.value })} /></div>
    <div className="brief-row"><Toggle checked={brief.evening} onChange={evening => set({ evening })} label="Evening study check-in: exams in the next 3 days and flashcards waiting" /><input type="time" value={brief.eveningAt} onChange={e => set({ eveningAt: e.target.value })} /></div>
    <Toggle checked={brief.away} onChange={away => set({ away })} label="“While you were away” on Home after 3 hours: what your other computer changed" />
    <p className="hint"><Brain size={12} /> Ask Mimir “what's my day?” for the same brief, in words.</p>
  </Card>
}
