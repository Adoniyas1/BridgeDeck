import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, Check } from 'lucide-react'
import { isTauri, studyAddCourse, studyPatchCourseInfo, studyStateGet, studyStateSet, type StudyCourse } from '../../lib/bridge'
import { Card, SectionTitle } from '../../ui'
import { courseMatches } from './canvas'
import { DAY_LETTERS } from './schedule'
import { refreshLibrary } from './state'
import { clash, clashes, meetingOf, readSchedule, sectionKey, type Section } from './timetable'

const FROM = 7 * 60, TO = 22 * 60
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))

/** Next semester: paste the sections of the courses you're thinking of from the class schedule,
 *  pick one of each (lecture and lab), see the week with clashes in red, and use them as the
 *  courses' class times. The draft is kept on both computers (study state `timetable`). */
export function Timetable({ courses, missing }: { courses: StudyCourse[]; missing: (code: string) => string[] }) {
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [status, setStatus] = useState('')
  useEffect(() => {
    if (!isTauri()) return
    void studyStateGet('timetable').then(s => { if (typeof s.text === 'string') setText(s.text); if (Array.isArray(s.picked)) setPicked(s.picked.filter((k): k is string => typeof k === 'string')) }).catch(() => undefined)
  }, [])
  const save = (next: { text?: string; picked?: string[] }) => { if (isTauri()) void studyStateSet('timetable', next).catch(() => undefined) }
  const sections = useMemo(() => readSchedule(text), [text])
  const groups = useMemo(() => {
    const m = new Map<string, Section[]>()
    for (const s of sections) m.set(`${s.course}|${s.kind}`, [...(m.get(`${s.course}|${s.kind}`) ?? []), s])
    return [...m.entries()]
  }, [sections])
  const chosen = sections.filter(s => picked.includes(sectionKey(s)))
  const bad = clashes(chosen)

  function pick(s: Section) {
    // One section per course and type (a lecture and its lab).
    const next = [...picked.filter(k => !k.startsWith(`${s.course}|`) || !k.endsWith(`|${s.kind}`)), sectionKey(s)]
    setPicked(next); save({ picked: next })
  }

  async function use() {
    const byCourse = new Map<string, Section[]>()
    for (const s of chosen) byCourse.set(s.course, [...(byCourse.get(s.course) ?? []), s])
    try {
      for (const [code, list] of byCourse) {
        const existing = courses.find(c => c.name === code || c.info.code === code || courseMatches(c.name, code))
        const name = existing?.name ?? code
        if (!existing) await studyAddCourse(code)
        await studyPatchCourseInfo(name, { meetings: list.map(meetingOf), ...(existing ? {} : { code, title: list[0].title }) })
      }
      await refreshLibrary()
      setStatus(`Class times set for ${[...byCourse.keys()].join(', ')}.`)
    } catch (e) { setStatus(String(e)) }
  }

  return <Card className="timetable"><SectionTitle title="Next semester's timetable" subtitle="Paste sections from the class schedule, pick one of each, and check for clashes" action={<CalendarRange size={18} />} />
    <textarea rows={text ? 4 : 6} value={text} placeholder={'EE 381  PROBABILITY AND STATISTICS\n01  6014  SEM  MW  11-12:15PM  ECS-302  Smith J\n02  6015  SEM  TuTh  2-3:15PM  VEC-115  Lee K'} onChange={e => setText(e.target.value)} onBlur={() => save({ text })} />
    {groups.length > 0 && <div className="timetable-pick">{groups.map(([key, list]) => {
      const [code, kind] = key.split('|')
      const gaps = missing(code)
      return <div key={key} className="timetable-course">
        <strong>{code}{kind && kind !== 'LEC' ? ` ${kind.toLowerCase()}` : ''}</strong> <small>{list[0].title}</small>
        {gaps.length > 0 && <small className="cal-error"> needs {gaps.join(', ')} first</small>}
        {list.map(s => <label key={sectionKey(s)} className={chosen.some(c => c !== s && clash(c, s)) ? 'clashes' : ''}>
          <input type="radio" name={key} checked={picked.includes(sectionKey(s))} onChange={() => pick(s)} />
          §{s.section} {s.days.map(d => DAY_LETTERS[d - 1]).join('')} {s.start}–{s.end} {s.room} <small>{s.instructor}</small>
        </label>)}
      </div>
    })}</div>}
    {chosen.length > 0 && <div className="timetable-week">
      {[1, 2, 3, 4, 5].map(day => <div key={day} className="timetable-day"><span>{DAY_LETTERS[day - 1]}</span>
        <div className="timetable-col">{chosen.filter(s => s.days.includes(day)).map(s => <div key={sectionKey(s)} className={`timetable-block${bad.some(([a, b]) => (a === s || b === s) && clash(a, b) && a.days.includes(day) && b.days.includes(day)) ? ' clash' : ''}`}
          style={{ top: `${((mins(s.start) - FROM) / (TO - FROM)) * 100}%`, height: `${((mins(s.end) - mins(s.start)) / (TO - FROM)) * 100}%` }} title={`${s.course} ${s.start}–${s.end} ${s.room}`}>{s.course}<small>{s.start}</small></div>)}</div>
      </div>)}
    </div>}
    {bad.length > 0 && <p className="cal-error">{bad.map(([a, b]) => `${a.course} and ${b.course} clash`).join('; ')}.</p>}
    {chosen.length > 0 && <div className="actions"><button disabled={!!bad.length || !isTauri()} onClick={() => void use()}><Check size={14} />Use these class times</button></div>}
    {status && <p className="hint">{status}</p>}
  </Card>
}
