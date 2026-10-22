import { useEffect, useRef, useState } from 'react'
import { Backpack, Clock, MapPin, Moon, ShieldCheck } from 'lucide-react'
import { useConfig } from '../../core/config'
import { notify } from '../../core/notify'
import { Card, SectionTitle } from '../../ui'
import { formatTime } from '../calendar/model'
import { startExam, useExams } from './assignments'
import { bringList, examNoticesDue, leaveBy, type Exam } from './exams'

const GIVEN_KEY = 'bd-exam-notices'
function given(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(GIVEN_KEY) ?? '[]') as string[]) } catch { return new Set() }
}
function remember(set: Set<string>) {
  try { localStorage.setItem(GIVEN_KEY, JSON.stringify([...set].slice(-100))) } catch { /* this run only */ }
}

const when = (exam: Exam) => new Date(exam.start).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' })

/** On Home from the day before an exam until it starts: where, when to leave, what to bring, and a
 *  button for exam mode. */
export function ExamDayCard() {
  const exams = useExams()
  const commute = useConfig().study.commuteMinutes
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(t) }, [])
  const soon = exams.filter(e => e.start > now && e.start - now < 36 * 3_600_000)
  if (!soon.length) return null
  return <>{soon.map(exam => <Card key={exam.id} className="exam-day">
    <SectionTitle title={`${exam.course}: ${exam.title}`} subtitle={`${when(exam)}${exam.covers ? ` · covers ${exam.covers}` : ''}`} action={<ShieldCheck size={18} />} />
    <div className="today-grid">
      <div className="today-tile"><span className="today-label"><MapPin size={13} />Where</span><strong>{exam.room || 'Room not set'}</strong>{!exam.room && <small>Finals are often not in the lecture room: check the schedule.</small>}</div>
      <div className="today-tile"><span className="today-label"><Clock size={13} />Leave by</span><strong>{formatTime(leaveBy(exam, commute))}</strong><small>{commute} min to get there + 15 to park and find the room</small></div>
      <div className="today-tile"><span className="today-label"><Backpack size={13} />Bring</span>{bringList(exam.allowed).map(b => <small key={b}>{b}</small>)}{exam.allowed && <small><b>Allowed:</b> {exam.allowed}</small>}</div>
      <div className="today-tile"><span className="today-label"><Moon size={13} />Tonight</span><strong>Sleep counts</strong><small>A good night helps more than a late review.</small>
        <button className="secondary" title="AI off, distracting sites closed, only reminders" onClick={() => void startExam(exam.course, Math.max(60, Math.round((exam.end - exam.start) / 60_000) + 30))}>Exam mode at the exam</button></div>
    </div>
  </Card>)}</>
}

/** The notices for exams: the evening before, and when to leave. */
export function ExamNotices() {
  const exams = useExams()
  const commute = useConfig().study.commuteMinutes
  const latest = useRef(exams)
  latest.current = exams
  useEffect(() => {
    const check = () => {
      const seen = given()
      const due = examNoticesDue(latest.current, Date.now(), commute, seen)
      for (const { key, exam, kind } of due) {
        seen.add(key)
        if (kind === 'evening') notify('reminders', `Exam tomorrow: ${exam.course} ${exam.title}`, `${when(exam)}${exam.room ? ` in ${exam.room}` : ''}. Bring: ${bringList(exam.allowed).slice(0, 4).join(', ')}. Sleep well.`)
        else notify('reminders', `Time to leave for ${exam.course} ${exam.title}`, `${formatTime(exam.start)}${exam.room ? ` in ${exam.room}` : ''}.`)
      }
      if (due.length) remember(seen)
    }
    check()
    const t = window.setInterval(check, 60_000)
    return () => window.clearInterval(t)
  }, [commute])
  return null
}
