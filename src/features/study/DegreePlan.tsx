import { useEffect, useRef, useState } from 'react'
import { Check, CircleDot, GraduationCap, Plus, Route } from 'lucide-react'
import { isTauri, studyAddCourse, studyPlanRead, studyPlanWrite, studyPatchCourseInfo, type StudyCourse } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { courseKey } from './canvas'
import { DECLARE_COURSES, eligibleNext, emptyPlanState, gpa, GRADE_POINTS, PLANS, plannedCode, planTotals, readPlanState, sameCourseTitle, type CourseStatus, type PlanCourse, type PlanState } from './plans'
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
  const tried = useRef(new Set<string>())
  useEffect(() => {
    if (!isTauri()) return
    // Each course once: a save that doesn't take mustn't start this again and again.
    const unnamed = courses.filter(s => !s.info.code && !courseKey(s.name) && !tried.current.has(s.name))
    unnamed.forEach(s => tried.current.add(s.name))
    const fixes = unnamed.flatMap(s => { const p = plan.semesters.flat().find(c => c.code && sameCourseTitle(s.name, c.title)); return p ? [{ s, p }] : [] })
    if (!fixes.length) return
    void Promise.all(fixes.map(({ s, p }) => studyPatchCourseInfo(s.name, { code: p.code, title: p.title.replace(/\s*\(\+.*\)$/, '') }))).then(() => refreshLibrary()).catch(() => undefined)
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
      await studyPatchCourseInfo(code, { code: courseKey(code) ?? code, title: course.code ? course.title.replace(/\s*\(\+.*\)$/, '') : '', canvasId: '', canvasCode: '' })
      await refreshLibrary()
      setStatus(`Added ${code} to your courses.`)
    } catch (e) { setStatus(errorText(e, 'Couldn’t add it')) }
  }

  const taking = plan.semesters.flat().filter(c => state.status[c.id] === 'taking' && !inStudy(plannedCode(c, state)))
  const overall = gpa(plan, state)
  const declaring = gpa(plan, state, DECLARE_COURSES)
  const declareDone = DECLARE_COURSES.every(id => state.status[id] === 'done')
  const setGrade = (course: PlanCourse, grade: string) => { const grades = { ...state.grades }; if (grade) grades[course.id] = grade; else delete grades[course.id]; save({ ...state, grades }) }
  return <><Card className="degree-plan">
    <SectionTitle title={plan.name} subtitle={`${plan.school} · ${totals.done} of ${totals.total} units done${totals.taking ? ` · ${totals.taking} this semester` : ''}`} action={<GraduationCap size={18} />} />
    <div className="degree-gpa">
      <span>GPA <b>{overall ? overall.gpa.toFixed(2) : '—'}</b> <small>{overall ? `over ${overall.units} graded units` : 'give finished courses their grade'}</small></span>
      <span className={declaring && declaring.gpa < 2.5 ? 'bad' : declaring && declareDone ? 'ok' : ''}>To declare in COE <b>{declaring ? declaring.gpa.toFixed(2) : '—'}</b> <small>needs 2.5 in MATH 122, 123, EE 186, PHYS 151, GE 1A, 1C before 60 units{declareDone ? ' · all done' : ''}</small></span>
    </div>
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
            {s === 'done' && <select className="degree-grade" title="Final grade" value={state.grades[course.id] ?? ''} onChange={e => setGrade(course, e.target.value)}><option value="">Grade</option>{Object.keys(GRADE_POINTS).map(g => <option key={g}>{g}</option>)}</select>}
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
  <NextSemester state={state} onSave={save} /></>
}

/** Next semester: the courses whose prerequisites are done (or being taken now), soonest in the
 *  plan first, to pick from; and what the rest are waiting for. */
function NextSemester({ state, onSave }: { state: PlanState; onSave: (s: PlanState) => void }) {
  const plan = PLANS.find(p => p.id === state.plan) ?? PLANS[0]
  const all = eligibleNext(plan, state)
  const ready = all.filter(n => !n.missing.length)
  const waiting = all.filter(n => n.missing.length).slice(0, 12)
  const picked = ready.filter(n => state.next.includes(n.course.id))
  const units = picked.reduce((s, n) => s + n.course.units, 0)
  const toggle = (id: string) => onSave({ ...state, next: state.next.includes(id) ? state.next.filter(x => x !== id) : [...state.next, id] })
  const label = (c: PlanCourse) => `${plannedCode(c, state) || '—'} · ${c.title}`
  return <Card className="degree-next">
    <SectionTitle title="Next semester" subtitle={picked.length ? `${picked.length} picked · ${units} units` : 'Courses you can take next, from what’s done and what you’re taking now'} action={<Route size={18} />} />
    {!ready.length ? <p className="hint">Mark the courses you’ve done and are taking above to see what opens up.</p>
      : <div className="degree-next-list">{ready.map(({ course, semester }) => <label key={course.id} className={state.next.includes(course.id) ? 'on' : ''}>
        <input type="checkbox" checked={state.next.includes(course.id)} onChange={() => toggle(course.id)} />
        <span className="grow">{label(course)}</span><small>{course.units}u · semester {semester + 1}</small>
      </label>)}</div>}
    {units > 0 && <p className={`hint${units > 18 ? ' warn' : ''}`}>{units} units{units > 18 ? ': more than 18 usually needs an overload approval.' : units < 12 ? ': under 12 is part-time.' : '.'}</p>}
    {waiting.length > 0 && <details className="degree-waiting"><summary>Not yet ({all.length - ready.length})</summary>
      {waiting.map(({ course, missing }) => <p key={course.id}><b>{label(course)}</b> <small>needs {missing.join(', ')}</small></p>)}
    </details>}
  </Card>
}
