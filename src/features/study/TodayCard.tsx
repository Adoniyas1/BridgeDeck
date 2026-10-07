import { useEffect, useMemo, useState } from 'react'
import { BookOpenCheck, Clock, Mail, MapPin, Play, Sun } from 'lucide-react'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle } from '../../ui'
import { formatTime } from '../calendar/model'
import { mailBadgeStore } from '../mail/state'
import { useAssignments } from './assignments'
import { belongsTo, dueText, type Assignment } from './canvas'
import { nextClass } from './schedule'
import { focusStore, libraryStore, startFocus, termStore } from './state'

const HOURS_48 = 48 * 3_600_000

/** "in 40 min", "now", "tomorrow 10:00". */
function untilText(start: number, end: number, now: number) {
  if (start <= now) return `now, until ${formatTime(end)}`
  const minutes = Math.round((start - now) / 60_000)
  if (minutes < 60) return `in ${minutes} min`
  if (new Date(start).toDateString() === new Date(now).toDateString()) return `today ${formatTime(start)}`
  return `${new Date(start).toLocaleDateString([], { weekday: 'long' })} ${formatTime(start)}`
}

/** School at a glance on Home: the next class, what's due in the next two days, unread mail, and a
 *  focus session for the most urgent course. */
export function TodayCard() {
  const library = useStore(libraryStore).library
  const term = useStore(termStore)
  const unread = useStore(mailBadgeStore)
  const focus = useStore(focusStore)
  const all = useAssignments()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t) }, [])
  const courses = useMemo(() => library?.courses.filter(c => !c.archived) ?? [], [library])
  const next = useMemo(() => nextClass(courses, term, now), [courses, term, now])
  const due = useMemo(() => all.filter(a => a.kind !== 'event' && !a.done && a.due != null && a.due < now + HOURS_48 && a.due > now - 7 * 86_400_000).sort((a, b) => a.due! - b.due!), [all, now])
  if (!courses.length && !due.length) return null

  // The Study course an assignment belongs to, for the focus timer.
  const courseOf = (a: Assignment) => courses.find(c => belongsTo({ name: c.name, code: c.info.code, canvasCode: c.info.canvasCode }, a.course))?.name ?? a.course
  const urgent = due[0]
  const study = (course: string) => { startFocus(course, 25); activateTab('study') }

  return <Card className="today-card">
    <SectionTitle title="Today" subtitle={new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} action={<Sun size={18} />} />
    <div className="today-grid">
      <div className="today-tile">
        <span className="today-label"><Clock size={13} />Next class</span>
        {next ? <>
          <strong>{next.course}{next.kind ? ` ${next.kind}` : ''}</strong>
          <small>{untilText(next.start, next.end, now)}{next.room ? <> · <MapPin size={11} /> {next.room}</> : null}</small>
        </> : <small>{courses.some(c => Array.isArray(c.info.meetings) && c.info.meetings.length) ? 'No classes in the next week' : 'Add class times to your courses in Study'}</small>}
      </div>
      <div className="today-tile">
        <span className="today-label"><BookOpenCheck size={13} />Due in 48 hours</span>
        <strong>{due.length ? `${due.length} assignment${due.length === 1 ? '' : 's'}` : 'Nothing'}</strong>
        {due.slice(0, 3).map(a => <small key={a.id} className={a.due! < now ? 'overdue' : ''}>{a.title} · {dueText(a.due, now)}</small>)}
      </div>
      <button className="today-tile" onClick={() => activateTab('mail')}>
        <span className="today-label"><Mail size={13} />Mail</span>
        <strong>{unread ? `${unread} unread` : 'All read'}</strong>
        <small>Open the Mail tab</small>
      </button>
      <div className="today-tile">
        <span className="today-label"><Play size={13} />Study</span>
        {focus ? <><strong>{focus.kind === 'break' ? 'On a break' : `Focusing on ${focus.course}`}</strong><small>until {formatTime(focus.endsAt)}</small></>
          : urgent ? <><strong>{courseOf(urgent)}</strong><small>{urgent.title} is due {dueText(urgent.due, now)}</small><button onClick={() => study(courseOf(urgent))}><Play size={13} />Start 25 min</button></>
            : <><strong>Nothing urgent</strong>{courses[0] && <button className="secondary" onClick={() => study(courses[0].name)}><Play size={13} />Study {courses[0].name}</button>}</>}
      </div>
    </div>
  </Card>
}
