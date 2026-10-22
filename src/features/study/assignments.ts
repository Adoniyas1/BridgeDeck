import { useMemo } from 'react'
import { canvasApi, canvasFeed, examSites, isTauri, notesCreate, notesSave, studyAddCourse, studyCanvasGet, studyCanvasPut, studyPatchCourseInfo, studyStateGet, studyStateSet } from '../../lib/bridge'
import { configStore, setConfig } from '../../core/config'
import { setExam } from '../../core/exam'
import { notify } from '../../core/notify'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { between, newId, visible } from '../notes/model'
import { notesStore } from '../notes/state'
import { apiAnnouncements, apiAssignments, apiCourses, assignmentRemindersDue, notHandedIn, assignmentsNote, ASSIGNMENTS_FOLDER, ASSIGNMENTS_TITLE, belongsTo, courseKey, courseMatches, dueText, feedAssignments, manualAssignments, mergeCanvas, studyNameFor, type Assignment, type CanvasCourse } from './canvas'
import { libraryStore, refreshLibrary, termStore } from './state'
import { classesBetween, classRemindersDue } from './schedule'
import { catalogTitle, sameCourseTitle } from './plans'
import { CACHE, canvasDoneStore, canvasStore, emptyCanvas, type CanvasData } from './canvasStore'

/** The calendar feed, or the Canvas site (read with an access token, or with the sign-in in BridgeDeck's browser). */
export const canvasConnected = () => { const c = configStore.get().canvas; return !!c.feed.trim() || !!c.base.trim() }

/** Reads the feed and the API. Course lists are read one course at a time in parallel. */
/** The newer of this computer's Canvas copy and the other computer's (so a computer that isn't
 *  signed in to Canvas still shows its assignments), and the items ticked done on either. */
export async function loadSharedCanvas() {
  if (!isTauri()) return
  const shared = await studyCanvasGet().catch(() => null) as Partial<CanvasData> | null
  if (shared && Array.isArray(shared.feed) && Array.isArray(shared.api) && (shared.at ?? 0) > canvasStore.get().at && !canvasStore.get().loading) {
    canvasStore.set(c => ({ ...c, feed: shared.feed!, api: shared.api!, courses: Array.isArray(shared.courses) ? shared.courses : c.courses, announcements: Array.isArray(shared.announcements) ? shared.announcements : c.announcements, at: shared.at ?? c.at }))
  }
  const state = await studyStateGet('canvasDone').catch(() => ({} as Record<string, unknown>))
  const legacy = configStore.get().canvas.done
  canvasDoneStore.set([...new Set([...legacy.filter(id => !(id in state) || state[id] === true), ...Object.keys(state).filter(id => state[id] === true)])])
}

export async function refreshCanvas() {
  if (!isTauri() || canvasStore.get().loading) return
  const { feed, base, token } = configStore.get().canvas
  if (!canvasConnected()) { await loadSharedCanvas(); return }
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
  // Shared with the other computer, the phone and Mimir.
  if (!errors.length) void studyCanvasPut({ at: data.at, feed: data.feed, api: data.api, courses: data.courses, announcements: data.announcements }).catch(() => undefined)
  else void loadSharedCanvas()
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
export function allAssignments(data = canvasStore.get(), notes = notesStore.get(), done = canvasDoneStore.get()): Assignment[] {
  return [...mergeCanvas(data.feed, data.api, done), ...manualAssignments(notes)]
}

export function useAssignments() {
  const data = useStore(canvasStore)
  const notes = useStore(notesStore)
  const done = useStore(canvasDoneStore)
  return useMemo(() => allAssignments(data, notes, done), [data, notes, done])
}

/** Ticks an assignment off (or back on): Canvas ones on this computer, added ones in their note. */
export async function toggleDone(a: Assignment) {
  if (a.source === 'canvas') {
    canvasDoneStore.set(list => a.done ? list.filter(id => id !== a.id) : [...list.filter(id => id !== a.id), a.id])
    // Older builds still read the done list from this computer's settings.
    setConfig(c => ({ ...c, canvas: { ...c.canvas, done: a.done ? c.canvas.done.filter(id => id !== a.id) : [...c.canvas.done.filter(id => id !== a.id), a.id].slice(-500) } }))
    if (isTauri()) await studyStateSet('canvasDone', { [a.id]: a.done ? null : true }).catch(() => undefined)
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

const classesAnnounced = new Set<string>()
/** Says where the next class is a little before it starts, with anything due at the start of it. */
export function checkClassReminders(now = Date.now()) {
  const library = libraryStore.get().library
  const lead = configStore.get().study.classRemindMinutes
  if (!library || lead <= 0) return
  const courses = library.courses.filter(c => !c.archived)
  for (const c of classRemindersDue(classesBetween(courses, termStore.get(), now, now + (lead + 1) * 60_000), now, lead, classesAnnounced)) {
    classesAnnounced.add(`${c.course}@${c.start}`)
    const info = courses.find(x => x.name === c.course)?.info
    const names = { name: c.course, code: info?.code, canvasCode: info?.canvasCode }
    const due = allAssignments().filter(a => !a.done && a.due != null && a.due > now - 3_600_000 && a.due <= c.end && belongsTo(names, a.course))
    const minutes = Math.max(1, Math.round((c.start - now) / 60_000))
    const where = c.room ? `${c.moved ? 'moved to ' : ''}${c.room}` : ''
    notify('reminders', `${c.course}${c.kind ? ` ${c.kind.toLowerCase()}` : ''} in ${minutes} min`, [where, ...due.slice(0, 3).map(a => `${a.title} due`)].filter(Boolean).join(' · '))
  }
}

const warnedUpload = new Set<string>()
export function checkAssignmentReminders(now = Date.now()) {
  for (const a of notHandedIn(allAssignments(), now)) {
    if (warnedUpload.has(a.id)) continue
    warnedUpload.add(a.id)
    notify('reminders', `Not handed in on Canvas: ${a.title}`, `${a.course ? `${a.course} · ` : ''}it's ticked done here, but Canvas has no submission (${dueText(a.due, now)}).`)
  }
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
