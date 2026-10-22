import { useMemo } from 'react'
import { canvasApi, canvasFeed, examSites, isTauri, notesCreate, notesSave, studyAddCourse, studyPatchCourseInfo } from '../../lib/bridge'
import { configStore, setConfig } from '../../core/config'
import { setExam } from '../../core/exam'
import { notify } from '../../core/notify'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { between, newId, visible } from '../notes/model'
import { notesStore } from '../notes/state'
import { apiAnnouncements, apiAssignments, apiCourses, assignmentRemindersDue, assignmentsNote, ASSIGNMENTS_FOLDER, ASSIGNMENTS_TITLE, belongsTo, courseKey, courseMatches, dueText, feedAssignments, manualAssignments, mergeCanvas, studyNameFor, type Assignment, type CanvasCourse } from './canvas'
import { libraryStore, refreshLibrary } from './state'
import { catalogTitle, sameCourseTitle } from './plans'
import { CACHE, canvasStore, emptyCanvas, type CanvasData } from './canvasStore'

/** The calendar feed, or the Canvas site (read with an access token, or with the sign-in in BridgeDeck's browser). */
export const canvasConnected = () => { const c = configStore.get().canvas; return !!c.feed.trim() || !!c.base.trim() }

/** Reads the feed and the API. Course lists are read one course at a time in parallel. */
export async function refreshCanvas() {
  if (!isTauri() || canvasStore.get().loading) return
  const { feed, base, token } = configStore.get().canvas
  if (!canvasConnected()) { canvasStore.set(emptyCanvas); return }
  canvasStore.set(c => ({ ...c, loading: true }))
  const previous = canvasStore.get()
  const errors: string[] = []
  let next = { feed: feed.trim() ? previous.feed : [], api: base.trim() ? previous.api : [], courses: previous.courses, announcements: previous.announcements }
  if (feed.trim()) {
    try { next.feed = feedAssignments(await canvasFeed(feed.trim())) } catch (e) { errors.push(`Calendar feed: ${errorText(e, 'didn’t load')}`) }
  }
  if (base.trim()) {
    try {
      const courses = apiCourses(await canvasApi(base, token, '/api/v1/courses?enrollment_state=active&include[]=total_scores&per_page=50'))
      const lists = await Promise.all(courses.map(c => canvasApi(base, token, `/api/v1/courses/${c.id}/assignments?include[]=submission&order_by=due_at&per_page=100`).then(list => apiAssignments(list, c)).catch(() => null)))
      const since = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10)
      const announcements = courses.length
        ? apiAnnouncements(await canvasApi(base, token, `/api/v1/announcements?${courses.map(c => `context_codes[]=course_${c.id}`).join('&')}&start_date=${since}&per_page=30`).catch(() => []), courses).slice(0, 20)
        : []
      // A course whose list didn't load keeps what it had.
      const api = lists.flatMap((list, i) => list ?? previous.api.filter(a => a.course === courses[i].code))
      next = { ...next, api, courses, announcements }
      void addCanvasCourses(courses).catch(() => undefined)
    } catch (e) { errors.push(`Canvas: ${errorText(e, 'didn’t answer')}`) }
  }
  const data: CanvasData = { ...next, at: errors.length ? previous.at : Date.now(), errors, loading: false }
  canvasStore.set(data)
  try { localStorage.setItem(CACHE, JSON.stringify({ ...data, errors: [] })) } catch { /* cache only */ }
}

/** Each Canvas course becomes a Study course the first time it's seen (unless one already matches),
 *  so it can be archived or deleted and stays that way. */
async function addCanvasCourses(courses: CanvasCourse[]) {
  if (!libraryStore.get().library) await refreshLibrary()
  const library = libraryStore.get().library
  if (!library) return
  const added = new Set(configStore.get().canvas.added)
  let changed = false
  for (const course of courses) {
    const code = courseKey(course.code) ?? courseKey(course.name) ?? ''
    const link = { canvasId: course.id, canvasCode: course.code }
    const study = library.courses.find(s => s.info.canvasId === course.id)
      ?? library.courses.find(s => !s.info.canvasId && (belongsTo({ name: s.name, code: s.info.code }, course.code) || courseMatches(s.name, course.name)
        // "Calc 3" is the plan's MATH 224 "Calculus 3".
        || (!s.info.code && !!catalogTitle(code) && sameCourseTitle(s.name, catalogTitle(code)))))
    if (study) {
      // Linked, so its assignments land in it whatever the names.
      if (study.info.canvasId !== course.id || study.info.canvasCode !== course.code) {
        await studyPatchCourseInfo(study.name, { ...link, ...(study.info.code ? {} : { code }), ...(study.info.title ? {} : { title: catalogTitle(code) }) })
        changed = true
      }
      continue
    }
    if (added.has(course.id)) continue
    const name = studyNameFor(course)
    await studyAddCourse(name)
    await studyPatchCourseInfo(name, { code, title: catalogTitle(code) || course.name, ...link }).catch(() => undefined)
    changed = true
  }
  if (courses.some(c => !added.has(c.id))) setConfig(c => ({ ...c, canvas: { ...c.canvas, added: [...new Set([...c.canvas.added, ...courses.map(f => f.id)])].slice(-200) } }))
  if (changed) await refreshLibrary()
}

/** Canvas assignments with this computer's done marks, and the ones added here. */
export function allAssignments(data = canvasStore.get(), notes = notesStore.get(), done = configStore.get().canvas.done): Assignment[] {
  return [...mergeCanvas(data.feed, data.api, done), ...manualAssignments(notes)]
}

export function useAssignments() {
  const data = useStore(canvasStore)
  const notes = useStore(notesStore)
  const done = useStore(configStore).canvas.done
  return useMemo(() => allAssignments(data, notes, done), [data, notes, done])
}

/** Ticks an assignment off (or back on): Canvas ones on this computer, added ones in their note. */
export async function toggleDone(a: Assignment) {
  if (a.source === 'canvas') {
    setConfig(c => ({ ...c, canvas: { ...c.canvas, done: a.done ? c.canvas.done.filter(id => id !== a.id) : [...c.canvas.done.filter(id => id !== a.id), a.id].slice(-500) } }))
    return
  }
  if (!a.noteId || !a.block) return
  const saved = await notesSave({ id: a.noteId, blocks: [{ ...a.block, checked: !a.done }] })
  notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
}

/** Adds an assignment by hand: a checklist item with a due date in Notes → Study → Assignments, so
 *  it's on both computers, in the calendar and reminded like any other. */
export async function addAssignment(course: string, title: string, due: number | null) {
  await addAssignments([{ course, title, due }])
}

/** Several at once (one save), e.g. a homework schedule read from a photo. */
export async function addAssignments(items: Array<{ course: string; title: string; due: number | null }>) {
  if (!items.length) return
  let note = assignmentsNote(notesStore.get())
  if (!note) {
    const created = await notesCreate('list', ASSIGNMENTS_FOLDER)
    note = await notesSave({ id: created.id, title: ASSIGNMENTS_TITLE, removed: created.blocks.map(b => b.id) })
  }
  let pos = visible(note).at(-1)?.pos ?? ''
  const blocks = items.map(({ course, title, due }) => {
    pos = between(pos, '')
    return { id: newId(), kind: 'todo' as const, text: course ? `${course}: ${title}` : title, checked: false, due, pos, updated: Date.now(), by: '', deleted: false }
  })
  const saved = await notesSave({ id: note.id, blocks })
  notesStore.set(list => list.some(n => n.id === saved.id) ? list.map(n => n.id === saved.id ? saved : n) : [saved, ...list])
}

const announced = new Set<string>()

export function checkAssignmentReminders(now = Date.now()) {
  for (const { assignment: a, lead } of assignmentRemindersDue(allAssignments(), now, configStore.get().canvas.remindHours, announced)) {
    notify('reminders', `${lead <= 60 ? 'Due within the hour' : 'Due soon'}: ${a.title}`, `${a.course ? `${a.course} · ` : ''}${dueText(a.due, now)}`)
  }
}

// ---- Exam mode ----

/** Starts exam mode for the exam's length: only reminders notify, and the sites in Settings → Study
 *  stay closed in the Browser and TV. */
export async function startExam(course: string, minutes: number) {
  setExam({ course, until: Date.now() + minutes * 60_000 })
  if (isTauri()) await examSites(configStore.get().study.examBlock).catch(() => undefined)
}

export async function endExam() {
  setExam(null)
  if (isTauri()) await examSites([]).catch(() => undefined)
}
