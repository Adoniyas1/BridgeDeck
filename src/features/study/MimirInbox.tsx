import { useState } from 'react'
import { Check, Sparkles, X } from 'lucide-react'
import { calendarSave, isTauri, studyStateGet, studyStateSet, type CalEvent } from '../../lib/bridge'
import { usePeriodicRefresh } from '../../core/refresh'
import { Card, SectionTitle } from '../../ui'
import { eventsStore, refreshEvents } from '../calendar/state'
import { newId } from '../notes/model'
import { addAssignment } from './assignments'
import { examNotesText } from './exams'
import { addCards } from './state'
import { CardText } from './CardText'

/** Something Mimir wants added, waiting for the user (study state `inbox`, from mimir_api.rs). */
export type InboxEntry = { id: string; kind: 'cards' | 'deadline' | 'exam' | string; course: string; payload: Record<string, unknown>; at: number }

/** The entries this build knows how to accept; others (from a newer build) are left alone. */
export function readInbox(raw: Record<string, unknown>): InboxEntry[] {
  return Object.entries(raw).flatMap(([id, v]) => {
    const e = v as Partial<InboxEntry> | null
    if (!e || typeof e.course !== 'string' || !['cards', 'deadline', 'exam'].includes(String(e.kind)) || typeof e.payload !== 'object' || !e.payload) return []
    return [{ id, kind: e.kind!, course: e.course, payload: e.payload as Record<string, unknown>, at: typeof e.at === 'number' ? e.at : 0 }]
  }).sort((a, b) => a.at - b.at)
}

const linesOf = (e: InboxEntry) => Array.isArray(e.payload.lines) ? e.payload.lines.filter((l): l is string => typeof l === 'string') : []
const when = (ms: unknown) => typeof ms === 'number' ? new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'no date'

/** What Mimir suggested adding (flashcards, deadlines, exams), to accept or turn down. Shared by
 *  both computers: accepted or turned down on one, it's gone on the other. */
export function MimirInbox({ onStatus }: { onStatus: (s: string) => void }) {
  const [entries, setEntries] = useState<InboxEntry[]>([])
  const [busy, setBusy] = useState('')
  async function load() { if (isTauri()) setEntries(readInbox(await studyStateGet('inbox').catch(() => ({})))) }
  usePeriodicRefresh(load, 15_000, [])

  async function done(id: string) {
    await studyStateSet('inbox', { [id]: null })
    setEntries(list => list.filter(e => e.id !== id))
  }

  async function accept(e: InboxEntry) {
    setBusy(e.id)
    try {
      const p = e.payload
      if (e.kind === 'cards') await addCards(e.course, linesOf(e))
      else if (e.kind === 'deadline') await addAssignment(e.course, String(p.title ?? 'Assignment'), typeof p.due === 'number' ? p.due : null)
      else if (e.kind === 'exam') {
        const start = Number(p.start), end = typeof p.end === 'number' && p.end > start ? p.end : start + 2 * 3_600_000
        const event: CalEvent = { id: newId(), title: `${e.course}: ${String(p.title ?? 'Exam')}`, start, end, allDay: false, location: String(p.room ?? ''), notes: examNotesText(String(p.allowed ?? ''), String(p.covers ?? '')), color: 'red', repeat: null, skip: [], reminder: 1440, updated: 0, by: '', deleted: false, seq: 0 }
        const saved = await calendarSave(event)
        eventsStore.set(list => [...list, saved])
        void refreshEvents()
      }
      await done(e.id)
    } catch (err) { onStatus(String(err)) } finally { setBusy('') }
  }

  if (!entries.length) return null
  return <Card><SectionTitle title="From Mimir" subtitle="Added only when you say so" action={<Sparkles size={18} />} />
    <div className="mimir-inbox">
      {entries.map(e => <div key={e.id} className="mimir-inbox-row">
        <div className="grow">
          <strong>{e.course}: {e.kind === 'cards' ? `${linesOf(e).length} flashcard${linesOf(e).length === 1 ? '' : 's'}` : e.kind === 'deadline' ? `${String(e.payload.title)}, due ${when(e.payload.due)}` : `${String(e.payload.title ?? 'Exam')} on ${when(e.payload.start)}${e.payload.room ? ` in ${String(e.payload.room)}` : ''}`}</strong>
          {e.kind === 'cards' && <ul>{linesOf(e).slice(0, 8).map((l, i) => <li key={i}><CardText text={l.replace(' :: ', ' → ').replace(' ::: ', ' ↔ ')} /></li>)}{linesOf(e).length > 8 && <li className="hint">and {linesOf(e).length - 8} more</li>}</ul>}
        </div>
        <button className="ghost" disabled={busy === e.id} onClick={() => void accept(e)}><Check size={14} />Add</button>
        <button className="ghost" title="Don’t add it" disabled={busy === e.id} onClick={() => void done(e.id).catch(err => onStatus(String(err)))}><X size={14} /></button>
      </div>)}
    </div>
  </Card>
}
