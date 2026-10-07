import { useEffect, useState } from 'react'
import { Check, CircleDot, GraduationCap, Plus } from 'lucide-react'
import { isTauri, studyAddCourse, studyPlanRead, studyPlanWrite, studySetCourseInfo, type StudyCourse } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { courseKey } from './canvas'
import { emptyPlanState, PLANS, plannedCode, planTotals, readPlanState, sameCourseTitle, type CourseStatus, type PlanCourse, type PlanState } from './plans'
import { refreshLibrary } from './state'

const NEXT: Record<string, CourseStatus | undefined> = { undefined: 'taking', taking: 'done', done: undefined }

/** The degree's courses by semester: click a course to mark it being taken, then done. Courses
 *  being taken can be added to Study (named by their code, with their title). */
export function DegreePlan({ courses, onOpen }: { courses: StudyCourse[]; onOpen: (name: string) => void }) {
  const [state, setState] = useState<PlanState | null>(null)
  const [status, setStatus] = useState('')
  useEffect(() => {
    if (!isTauri()) { setState(emptyPlanState()); return }
    void studyPlanRead().then(text => setState(text ? readPlanState(text) : emptyPlanState())).catch(e => { setState(emptyPlanState()); setStatus(errorText(e, 'Couldn’t read the plan')) })
  }, [])
  const plan = PLANS.find(p => p.id === state?.plan) ?? PLANS[0]
  // A course named by hand ("Calc 3") that's a plan course ("MATH 224 · Calculus 3") gets the code
  // and title, so Canvas and the plan find it.
  useEffect(() => {
    if (!isTauri()) return
    const unnamed = courses.filter(s => !s.info.code && !courseKey(s.name))
    const fixes = unnamed.flatMap(s => { const p = plan.semesters.flat().find(c => c.code && sameCourseTitle(s.name, c.title)); return p ? [{ s, p }] : [] })
    if (!fixes.length) return
    void Promise.all(fixes.map(({ s, p }) => studySetCourseInfo(s.name, { ...s.info, code: p.code, title: p.title.replace(/\s*\(\+.*\)$/, '') }))).then(() => refreshLibrary()).catch(() => undefined)
  }, [courses, plan])
  if (!state) return <Card><p className="hint">Reading the plan…</p></Card>
  const totals = planTotals(plan, state)

  function save(next: PlanState) {
    setState(next)
    if (isTauri()) void studyPlanWrite(JSON.stringify(next, null, 2)).catch(e => setStatus(errorText(e, 'Couldn’t save the plan')))
  }
  const cycle = (course: PlanCourse) => {
    const nextStatus = NEXT[String(state.status[course.id])]
    const status = { ...state.status }
    if (nextStatus) status[course.id] = nextStatus; else delete status[course.id]
    save({ ...state, status })
  }
  const choose = (course: PlanCourse) => {
    const value = window.prompt(`Which course for “${course.title}”? (e.g. ${course.note?.match(/EE \d{3}/)?.[0] ?? 'EE 482'})`, state.chosen[course.id] ?? '')
    if (value == null) return
    const chosen = { ...state.chosen }
    if (value.trim()) chosen[course.id] = value.trim(); else delete chosen[course.id]
    save({ ...state, chosen })
  }
  const inStudy = (code: string) => courses.find(s => s.info.code === code || courseKey(s.name) === courseKey(code))

  async function addToStudy(course: PlanCourse) {
    const code = plannedCode(course, state!)
    if (!code) { choose(course); return }
    try {
      await studyAddCourse(code)
      await studySetCourseInfo(code, { code: courseKey(code) ?? code, title: course.code ? course.title.replace(/\s*\(\+.*\)$/, '') : '', canvasId: '', canvasCode: '' })
      await refreshLibrary()
      setStatus(`Added ${code} to your courses.`)
    } catch (e) { setStatus(errorText(e, 'Couldn’t add it')) }
  }

  const taking = plan.semesters.flat().filter(c => state.status[c.id] === 'taking' && !inStudy(plannedCode(c, state)))
  return <Card className="degree-plan">
    <SectionTitle title={plan.name} subtitle={`${plan.school} · ${totals.done} of ${totals.total} units done${totals.taking ? ` · ${totals.taking} this semester` : ''}`} action={<GraduationCap size={18} />} />
    <div className="degree-progress"><i style={{ width: `${(totals.done / totals.total) * 100}%` }} /><i className="taking" style={{ width: `${(totals.taking / totals.total) * 100}%` }} /></div>
    <p className="hint">Click a course to mark it <strong>taking</strong>, click again for <strong>done</strong>. Courses you’re taking can go into Study with one click; Canvas courses with the same code link to them by themselves.</p>
    {taking.length > 0 && <div className="actions"><button onClick={() => void (async () => { for (const c of taking) await addToStudy(c) })()}><Plus size={14} />Add the {taking.length} course{taking.length === 1 ? '' : 's'} you’re taking to Study</button></div>}
    <div className="degree-grid">{plan.semesters.map((semester, i) => <div key={i} className="degree-semester">
      <h4>Semester {i + 1} <small>{semester.reduce((s, c) => s + c.units, 0)}u</small></h4>
      {semester.map(course => {
        const code = plannedCode(course, state)
        const study = code ? inStudy(code) : undefined
        const s = state.status[course.id]
        return <div key={course.id} className={`degree-course ${s ?? 'planned'}`}>
          <button className="degree-main" title={[course.pre ? `Prerequisites: ${course.pre}` : '', course.note ?? '', course.or ? `Or ${course.or}` : ''].filter(Boolean).join('\n') || undefined} onClick={() => cycle(course)}>
            <span className="degree-mark">{s === 'done' ? <Check size={12} /> : s === 'taking' ? <CircleDot size={12} /> : null}</span>
            <span className="degree-text"><b>{code || (course.code ? course.code : '—')}</b> <small>{course.units}u</small><br /><span>{course.title}</span>{course.or && <em> or {course.or}</em>}</span>
          </button>
          <div className="degree-actions">
            {!course.code && <button className="ghost" title="Choose the course for this slot" onClick={() => choose(course)}>{code ? 'Change' : 'Choose'}</button>}
            {study ? <button className="ghost" onClick={() => onOpen(study.name)}>Open</button>
              : s === 'taking' && <button className="ghost" title="Add to your Study courses" onClick={() => void addToStudy(course)}><Plus size={12} />Study</button>}
          </div>
        </div>
      })}
    </div>)}</div>
    {plan.notes.map(n => <p key={n} className="hint">{n}</p>)}
    {status && <p className="hint">{status}</p>}
  </Card>
}
