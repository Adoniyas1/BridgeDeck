import { useMemo, useState } from 'react'
import { CalendarPlus, Mail, Users } from 'lucide-react'
import { calendarReadIcs, openExternal, pickIcsFile, studyPatchCourseInfo, type StudyCourse } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { fromIcs } from '../calendar/ics'
import { Card, SectionTitle } from '../../ui'
import { useStore } from '../../core/store'
import { libraryStore, refreshLibrary } from './state'
import { peopleOf } from './CoursePeople'
import { busyFromEvents, busyText, clockText, freeSlots, parseBusy, type Busy } from './groups'
import type { Person } from './CoursePeople'
import { meetingsOf, DAY_LETTERS } from './schedule'

const PARTNER = /partner|classmate|group/i

/** Lab partners and classmates in a course (added under People with their class times as their
 *  hours): when you're all free this week, and one email to them all. */
export function StudyGroupCard({ course }: { course: StudyCourse }) {
  const courses = useStore(libraryStore).library?.courses ?? []
  const partners = peopleOf(course.info).filter(p => PARTNER.test(p.role))
  const mine: Busy[] = useMemo(() => courses.filter(c => !c.archived).flatMap(c => meetingsOf(c.info).map(m => ({ days: m.days, start: Number(m.start.slice(0, 2)) * 60 + Number(m.start.slice(3)), end: Number(m.end.slice(0, 2)) * 60 + Number(m.end.slice(3)) }))), [courses])
  const theirs = useMemo(() => partners.flatMap(p => parseBusy(p.hours)), [partners])
  const slots = useMemo(() => freeSlots([...mine, ...theirs]), [mine, theirs])
  const [status, setStatus] = useState('')
  /** A partner's calendar file (.ics) read into their hours: what's on each weekday this week. */
  async function fromCalendar(person: Person) {
    try {
      const path = await pickIcsFile('open')
      if (!path) return
      const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
      const hours = busyText(busyFromEvents(fromIcs(await calendarReadIcs(path)), monday.getTime()))
      if (!hours) return setStatus('Nothing on weekdays this week in that calendar.')
      const people = (Array.isArray(course.info.people) ? course.info.people : []).map(raw => {
        const p = raw as Record<string, unknown>
        return p.name === person.name && (p.email ?? '') === person.email && p.role === person.role ? { ...p, hours } : p
      })
      await studyPatchCourseInfo(course.name, { people })
      await refreshLibrary()
      setStatus(`${person.name || person.email}’s times: ${hours}`)
    } catch (e) { setStatus(errorText(e, 'Couldn’t read that calendar')) }
  }
  if (!partners.length) return null
  const emails = partners.map(p => p.email).filter(Boolean)
  const unread = partners.filter(p => p.hours.trim() && !parseBusy(p.hours).length)
  return <Card><SectionTitle title="Study group" subtitle={partners.map(p => p.name || p.email).join(', ')} action={<Users size={18} />} />
    <p className="hint">Free for everyone (Mon–Fri, 8am–8pm, an hour or more), from your class times and theirs:</p>
    <div className="group-slots">{[1, 2, 3, 4, 5].map(day => <div key={day}><strong>{DAY_LETTERS[day - 1]}</strong>{slots.filter(s => s.day === day).map(s => <span key={s.start}>{clockText(s.start)}–{clockText(s.end)}</span>)}{!slots.some(s => s.day === day) && <small>—</small>}</div>)}</div>
    {unread.length > 0 && <p className="hint">Couldn’t read the class times of {unread.map(p => p.name).join(', ')}: write them like “MW 10:00-11:15, TuTh 2-3:15pm” in their hours under People.</p>}
    <div className="actions">{partners.map(p => <button key={`${p.name}${p.email}`} className="ghost" title={`Read ${p.name || p.email}’s class times from a calendar file (.ics) they send you`} onClick={() => void fromCalendar(p)}><CalendarPlus size={14} />{p.name || p.email}’s calendar</button>)}</div>
    {status && <p className="hint">{status}</p>}
    {emails.length > 0 && <div className="actions"><button className="ghost" onClick={() => void openExternal(`mailto:${emails.join(',')}?subject=${encodeURIComponent(`${course.name} study group`)}&body=${encodeURIComponent(`Free times this week:\n${slots.map(s => `${DAY_LETTERS[s.day - 1]} ${clockText(s.start)}–${clockText(s.end)}`).join('\n')}`)}`)}><Mail size={14} />Email them the free times</button></div>}
    <p className="hint">To share flashcards: Flashcards → Export saves a CSV in the course folder to send; they import it with Import.</p>
  </Card>
}
