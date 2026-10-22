import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { BookCheck, CalendarClock, Camera, Check, ExternalLink, GraduationCap, Megaphone, Plus, RefreshCw, ShieldCheck, Square, SquareCheck } from 'lucide-react'
import { examSites, isTauri } from '../../lib/bridge'
import { configStore, useConfig } from '../../core/config'
import { examStore, loadSharedExam } from '../../core/exam'
import { setNotice } from '../../core/notice'
import { notify } from '../../core/notify'
import { usePeriodicRefresh } from '../../core/refresh'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { openInNewTab } from '../browser/state'
import { fromInputs } from '../calendar/model'
import { belongsTo, dueText, groupAssignments, notHandedIn, type Assignment } from './canvas'
import { addAssignment, canvasConnected, checkAssignmentReminders, checkClassReminders, checkGradeRisk, endExam, loadSharedCanvas, refreshCanvas, startExam, toggleDone, useAssignments } from './assignments'
import { HomeworkImport } from './HomeworkImport'
import { ExamNotices } from './ExamDay'
import { expandProblems, problemLabel } from './problems'
import { libraryStore, loadProblems, problemsStore, refreshLibrary, termStore, tickProblem } from './state'
import { parseQuickAdd } from './quickAdd'
import { meetingsOf } from './schedule'
import { canvasStore } from './canvasStore'

const KIND_LABEL: Record<Assignment['kind'], string> = { assignment: '', quiz: 'Quiz', discussion: 'Discussion', event: 'Event' }

function Row({ a, now }: { a: Assignment; now: number }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const problems = useMemo(() => expandProblems(a.title), [a.title])
  const ticked = useStore(problemsStore)[a.id] ?? []
  useEffect(() => { if (problems.length > 1) void loadProblems() }, [problems.length])
  const doneCount = problems.filter(p => ticked.includes(p.key)).length
  const overdue = !a.done && a.due != null && a.due < now
  const toggle = () => { setBusy(true); void toggleDone(a).catch(e => setNotice(errorText(e, 'Couldn’t change it'))).finally(() => setBusy(false)) }
  const sections = new Set(problems.map(p => p.section)).size > 1
  return <div className={`assignment-row${a.done ? ' done' : ''}${overdue ? ' overdue' : ''}`}>
    <button className="cal-icon" title={a.done ? 'Mark not done' : a.source === 'canvas' ? 'Mark done (on this computer)' : 'Mark done'} disabled={busy || a.submitted}
      onClick={toggle}>
      {a.done ? <SquareCheck size={16} /> : <Square size={16} />}
    </button>
    <div className="grow">
      <strong>{a.title}</strong>
      <small>{[a.course, KIND_LABEL[a.kind], dueText(a.due, now), a.points ? `${a.points} pts` : '', a.submitted ? (a.grade ? `Graded: ${a.grade}` : 'Submitted') : '', a.missing && !a.submitted ? 'Missing' : ''].filter(Boolean).join(' · ')}</small>
      {notHandedIn([a], now).length > 0 && <small className="cal-error">Ticked done, but Canvas has no submission: upload it?</small>}
      {open && <div className="problem-grid">{problems.map(p => <button key={p.key} className={ticked.includes(p.key) ? 'on' : ''} onClick={() => tickProblem(a.id, p.key)}>{problemLabel(p, sections)}</button>)}
        {doneCount === problems.length && !a.done && <button className="problem-finish" onClick={toggle}><Check size={12} />All done: mark it done</button>}</div>}
    </div>
    {problems.length > 1 && <button className={`problem-count${open ? ' open' : ''}`} title="Problems to tick off" onClick={() => setOpen(v => !v)}>
      <span className="problem-bar"><i style={{ width: `${(doneCount / problems.length) * 100}%` }} /></span>{doneCount}/{problems.length}
    </button>}
    {a.url && <button className="ghost" title="Open in Canvas (Browser tab)" onClick={() => openInNewTab(a.url)}><ExternalLink size={14} /></button>}
  </div>
}

/** Everything due, from Canvas and added here: overdue, today, this week, later. */
export function AssignmentsCard({ course, info, courses }: { course?: string; info?: { code: string; canvasCode: string }; courses: string[] }) {
  const all = useAssignments()
  const data = useStore(canvasStore)
  const config = useConfig()
  // In a course: its own assignments first (Canvas ones by the linked course or the catalog code).
  const [onlyThis, setOnlyThis] = useState(true)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [forCourse, setForCourse] = useState(course ?? '')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('23:59')
  const [showDone, setShowDone] = useState(false)
  const [fromPhoto, setFromPhoto] = useState(false)
  const now = Date.now()
  const list = useMemo(() => onlyThis && course ? all.filter(a => belongsTo({ name: course, code: info?.code, canvasCode: info?.canvasCode }, a.course)) : all, [all, onlyThis, course, info?.code, info?.canvasCode])
  const groups = groupAssignments(list, now)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const connected = useMemo(canvasConnected, [config.canvas])
  const open = groups.overdue.length + groups.today.length + groups.week.length + groups.later.length + groups.undated.length

  // Typed in plain words: "EE 310 HW 5 due next class ~3h". The date boxes, when filled, win.
  const library = useStore(libraryStore).library
  const term = useStore(termStore)
  const studyCourses = useMemo(() => library?.courses.filter(c => !c.archived) ?? [], [library])
  const parsed = useMemo(() => parseQuickAdd(title, studyCourses, term, Date.now(), forCourse.trim()), [title, studyCourses, term, forCourse])
  const chosen = studyCourses.find(c => c.name === (parsed.course || forCourse.trim()))
  const chips = chosen ? ['class', ...new Set(meetingsOf(chosen.info).map(m => m.kind.toLowerCase()).filter(k => /lab|lecture|discussion/.test(k)))] : []
  async function add() {
    if (!parsed.title.trim()) return
    try {
      await addAssignment(parsed.course || forCourse.trim(), parsed.title.trim(), date ? fromInputs(date, time || '23:59') : parsed.due)
      setTitle(''); setDate(''); setAdding(false)
    } catch (e) { setNotice(errorText(e, 'Couldn’t add it')) }
  }

  const section = (name: string, items: Assignment[]) => items.length > 0 && <div className="assignment-group">
    <h4>{name} <small>{items.length}</small></h4>
    {items.map(a => <Row key={a.id} a={a} now={now} />)}
  </div>

  return <Card className="assignments-card">
    <SectionTitle title="Assignments" subtitle={connected ? `${open} to do${data.at ? ` · Canvas checked ${new Date(data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` : 'Add them here, or connect Canvas in Settings → Study'}
      action={<div className="actions">
        {course && <button className={onlyThis ? '' : 'secondary'} onClick={() => setOnlyThis(v => !v)}>{onlyThis ? course : 'All courses'}</button>}
        {connected && <button className="secondary" title="Check Canvas now" disabled={data.loading} onClick={() => void refreshCanvas()}><RefreshCw size={14} className={data.loading ? 'spin' : undefined} /></button>}
        {course && <button className="secondary" title="Add a course’s homework from a photo of the sheet" onClick={() => setFromPhoto(v => !v)}><Camera size={14} />From photo</button>}
        <button className="secondary" title="Add an assignment" onClick={() => setAdding(v => !v)}><Plus size={14} />Add</button>
      </div>} />
    {data.errors.map(e => <p key={e} className="cal-error">{e}</p>)}
    {fromPhoto && course && <HomeworkImport course={course} onClose={() => setFromPhoto(false)} />}
    {adding && <form className="assignment-add" onSubmit={e => { e.preventDefault(); void add() }}>
      <input autoFocus placeholder="EE 310 HW 5 due next class ~3h" title="Type it in plain words: the course, what it is, “due next class / next lab / fri 5pm / 10/31”, and ~hours" value={title} onChange={e => setTitle(e.target.value)} />
      <input list="assignment-courses" placeholder="Course" value={forCourse} onChange={e => setForCourse(e.target.value)} />
      <datalist id="assignment-courses">{courses.map(c => <option key={c} value={c} />)}</datalist>
      <input type="date" value={date} onChange={e => setDate(e.target.value)} />
      <input type="time" value={time} onChange={e => setTime(e.target.value)} />
      <button disabled={!parsed.title.trim()}>Add</button>
      {title.trim() && <p className="hint assignment-preview">{parsed.course || 'No course'} · {parsed.title || '…'} · {date ? 'due as set' : parsed.due ? `due ${new Date(parsed.due).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${parsed.dueText.startsWith('next') ? ` (${parsed.dueText})` : ''}` : 'no due date'}</p>}
      {!!chips.length && <span className="assignment-chips">{chips.map(k => <button type="button" key={k} className="ghost" onClick={() => setTitle(t => `${t.replace(/\s+(due|by)\s+.*$/i, '')} due next ${k}`)}>next {k}</button>)}</span>}
    </form>}
    {section('Overdue', groups.overdue)}
    {section('Today', groups.today)}
    {section('This week', groups.week)}
    {section('Later', groups.later)}
    {section('No due date', groups.undated)}
    {!open && <p className="hint">{connected ? 'Nothing due. Nice.' : 'Nothing due. Connect Canvas in Settings → Study to see your courses’ assignments here, in the calendar and as reminders.'}</p>}
    {groups.done.length > 0 && <button className="ghost assignment-done-toggle" onClick={() => setShowDone(v => !v)}><BookCheck size={14} /> {showDone ? 'Hide' : 'Show'} {groups.done.length} done</button>}
    {showDone && groups.done.map(a => <Row key={a.id} a={a} now={now} />)}
  </Card>
}

/** Grades and recent announcements from the Canvas API. */
export function CanvasCard() {
  const data = useStore(canvasStore)
  const [openId, setOpenId] = useState<string | null>(null)
  if (!data.courses.length && !data.announcements.length) return null
  return <Card><SectionTitle title="Canvas" subtitle="Current grades and announcements" action={<GraduationCap size={18} />} />
    {data.courses.some(c => c.score != null || c.grade) && <div className="canvas-grades">{data.courses.filter(c => c.score != null || c.grade).map(c => <div key={c.id} className="canvas-grade">
      <span className="grow" title={c.name}>{c.code}</span><strong>{c.grade || ''}{c.score != null ? ` ${Math.round(c.score * 10) / 10}%` : ''}</strong>
    </div>)}</div>}
    {data.announcements.length > 0 && <div className="canvas-announcements">{data.announcements.slice(0, 8).map(a => <div key={a.id} className="canvas-announcement">
      <button className="ghost" onClick={() => setOpenId(openId === a.id ? null : a.id)}><Megaphone size={13} /><span className="grow">{a.title}</span><small>{a.course} · {new Date(a.posted).toLocaleDateString([], { month: 'short', day: 'numeric' })}</small></button>
      {openId === a.id && <div className="canvas-announcement-text"><p>{a.text}</p>{a.url && <button className="ghost" onClick={() => openInNewTab(a.url)}><ExternalLink size={13} /> Open in Canvas</button>}</div>}
    </div>)}</div>}
  </Card>
}

const clock = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

/** Exam mode: notifications quiet (reminders still come), distracting sites closed, a timer. */
export function ExamCard({ course }: { course: string }) {
  const exam = useStore(examStore)
  const config = useConfig()
  const [minutes, setMinutes] = useState(120)
  return <Card><SectionTitle title="Exam mode" subtitle={exam ? `On for ${exam.course}` : 'Quiet notifications, distracting sites closed'} action={<ShieldCheck size={18} />} />
    {exam ? <div className="study-focus">
      <div className="grow"><strong>{clock(exam.until - Date.now())} left</strong><small>Only reminders notify. {config.study.examBlock.length} sites are closed in the Browser and TV.</small></div>
      <button className="ghost" onClick={() => void endExam()}>End</button>
    </div> : <div className="actions">
      <select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{[30, 60, 90, 120, 180, 240].map(m => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h${m % 60 ? ' 30' : ''}`}</option>)}</select>
      <button onClick={() => void startExam(course, minutes)}><ShieldCheck size={14} />Start</button>
    </div>}
  </Card>
}

/** On Home: what's due in the next seven days (and anything overdue). */
export function DueSoonCard() {
  const all = useAssignments()
  const now = Date.now()
  const groups = groupAssignments(all, now)
  const soon = [...groups.overdue, ...groups.today, ...groups.week]
  if (!soon.length) return null
  return <Card><SectionTitle title="Due this week" subtitle={`${soon.length} assignment${soon.length === 1 ? '' : 's'}${groups.overdue.length ? ` · ${groups.overdue.length} overdue` : ''}`} action={<button className="ghost" onClick={() => activateTab('study')}><CalendarClock size={14} /> Study</button>} />
    {soon.slice(0, 8).map(a => <Row key={a.id} a={a} now={now} />)}
    {soon.length > 8 && <p className="hint">And {soon.length - 8} more in the Study tab.</p>}
  </Card>
}

/** Checks Canvas every half hour, sends assignment reminders, keeps exam mode's blocking in step,
 *  and shows the exam banner. */
export function StudyBackground() {
  const exam = useStore(examStore)
  const canvas = useConfig().canvas
  const [, setTick] = useState(0)
  usePeriodicRefresh(async () => { await loadSharedCanvas(); await refreshCanvas(); checkAssignmentReminders() }, 30 * 60_000, [canvas.feed, canvas.base, canvas.token], 'same')
  useEffect(() => {
    const timer = window.setInterval(() => { void loadSharedExam(); checkAssignmentReminders(); checkClassReminders(); checkGradeRisk(); setTick(t => t + 1) }, 60_000)
    void loadSharedExam()
    return () => window.clearInterval(timer)
  }, [])
  // Homework scanned on the phone lands in its course as a PDF: show it, and say so.
  useEffect(() => {
    if (!isTauri()) return
    const off = listen<{ course: string; file: string; pages: number }>('study-scan', e => {
      void refreshLibrary()
      notify('reminders', 'Scan saved', `${e.payload.file} (${e.payload.pages} page${e.payload.pages === 1 ? '' : 's'}) is in ${e.payload.course}.`)
    })
    return () => { void off.then(stop => stop()) }
  }, [])
  // Exam mode survives a restart: block again, and end it when its time is up.
  useEffect(() => {
    if (!exam) return
    if (isTauri()) void examSites(configStore.get().study.examBlock).catch(() => undefined)
    const left = exam.until - Date.now()
    const timer = window.setTimeout(() => {
      void endExam()
      notify('reminders', 'Exam mode ended', `${exam.course}: notifications and sites are back.`)
    }, Math.max(0, left))
    return () => window.clearTimeout(timer)
  }, [exam])
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let closed = false
    void listen<{ url: string }>('exam-blocked', e => {
      let host = e.payload.url
      try { host = new URL(e.payload.url).hostname.replace(/^www\./, '') } catch { /* show it as is */ }
      setNotice(`${host} is closed during exam mode.`)
    }).then(fn => { if (closed) fn(); else unlisten = fn })
    return () => { closed = true; unlisten?.() }
  }, [])
  if (!exam) return <ExamNotices />
  return <><ExamNotices /><div className="notice exam-banner"><ShieldCheck size={15} /><span>Exam mode for {exam.course}: {clock(exam.until - Date.now())} left. Only reminders notify; distracting sites are closed.</span><button className="secondary" onClick={() => void endExam()}>End</button></div></>
}
