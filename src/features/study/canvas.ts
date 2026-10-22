import type { Note, NoteBlock } from '../../lib/bridge'
import { fromIcs } from '../calendar/ics'
import { addDays, startOfDay } from '../calendar/model'
import { visible } from '../notes/model'

/** Something due: from Canvas (the calendar feed or the API), or added here (a checklist item with a
 *  due date in the "Assignments" note). */
export type Assignment = {
  id: string
  source: 'canvas' | 'manual'
  kind: 'assignment' | 'quiz' | 'discussion' | 'event'
  title: string
  course: string
  due: number | null
  url: string
  points: number | null
  submitted: boolean
  missing: boolean
  grade: string
  done: boolean
  /** Canvas said whether it's been handed in on Canvas (from the API, not the calendar feed). */
  online?: boolean
  noteId?: string
  block?: NoteBlock
}

export type CanvasCourse = { id: string; name: string; code: string; score: number | null; grade: string }
export type Announcement = { id: string; title: string; course: string; posted: number; url: string; text: string }

export const ASSIGNMENTS_TITLE = 'Assignments'
export const ASSIGNMENTS_FOLDER = 'Study'

/** "Homework 3 [MATH 221 Fall 2026]" → the title and the course. */
export function splitCourse(summary: string): { title: string; course: string } {
  const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/)
  return m ? { title: m[1].trim() || summary, course: m[2].trim() } : { title: summary.trim(), course: '' }
}

/** Assignments and course events in a Canvas calendar feed. */
export function feedAssignments(ics: string): Assignment[] {
  // fromIcs keeps the times; the links are read from the raw events, keyed by UID.
  const links = new Map<string, string>()
  for (const block of ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split(/BEGIN:VEVENT/i).slice(1)) {
    const uid = block.match(/^UID[^:\n]*:(.*)$/im)?.[1].trim()
    const url = block.match(/^URL[^:\n]*:(.*)$/im)?.[1].trim()
    if (uid && url) links.set(uid.replace(/[^A-Za-z0-9-]/g, ''), url)
  }
  return fromIcs(ics).flatMap((event): Assignment[] => {
    const uid = event.id.replace(/^ics-/, '')
    const assignment = uid.match(/event-assignment-(\d+)/)
    const { title, course } = splitCourse(event.title)
    const url = links.get(uid) ?? ''
    // A whole-day due date is due by the end of that day.
    const due = event.allDay ? addDays(event.start, 1) - 60_000 : event.start
    const base = { source: 'canvas' as const, title, course, due, url: /^https:\/\//.test(url) ? url : '', points: null, submitted: false, missing: false, grade: '', done: false }
    if (assignment) return [{ ...base, id: `canvas:${assignment[1]}`, kind: 'assignment' as const }]
    if (/event-calendar-event-/.test(uid)) return [{ ...base, id: `canvas-event:${uid.replace(/\D/g, '')}`, kind: 'event' as const, due: event.start }]
    return []
  })
}

type ApiCourse = { id: number; name?: string; course_code?: string; access_restricted_by_date?: boolean; enrollments?: Array<{ computed_current_score?: number | null; computed_current_grade?: string | null }> }
type ApiAssignment = { id: number; name?: string; due_at?: string | null; html_url?: string; points_possible?: number | null; submission_types?: string[]; submission?: { submitted_at?: string | null; workflow_state?: string; grade?: string | null; missing?: boolean } }
type ApiAnnouncement = { id: number; title?: string; posted_at?: string | null; html_url?: string; message?: string; context_code?: string }

export function apiCourses(list: unknown): CanvasCourse[] {
  if (!Array.isArray(list)) return []
  return (list as ApiCourse[]).filter(c => typeof c?.id === 'number' && c.name && !c.access_restricted_by_date).map(c => {
    const enrollment = c.enrollments?.find(e => e.computed_current_score != null || e.computed_current_grade)
    return { id: String(c.id), name: c.name!, code: c.course_code || c.name!, score: enrollment?.computed_current_score ?? null, grade: enrollment?.computed_current_grade ?? '' }
  })
}

export function apiAssignments(list: unknown, course: CanvasCourse): Assignment[] {
  if (!Array.isArray(list)) return []
  return (list as ApiAssignment[]).filter(a => typeof a?.id === 'number').map(a => {
    const types = a.submission_types ?? []
    const sub = a.submission
    const submitted = !!sub && (!!sub.submitted_at || sub.workflow_state === 'submitted' || sub.workflow_state === 'graded' || sub.workflow_state === 'pending_review')
    const due = a.due_at ? Date.parse(a.due_at) : NaN
    return {
      id: `canvas:${a.id}`,
      source: 'canvas',
      kind: types.includes('online_quiz') ? 'quiz' : types.includes('discussion_topic') ? 'discussion' : 'assignment',
      title: a.name || 'Assignment',
      course: course.code,
      due: Number.isFinite(due) ? due : null,
      url: a.html_url && /^https:\/\//.test(a.html_url) ? a.html_url : '',
      points: a.points_possible ?? null,
      submitted,
      missing: !!sub?.missing,
      grade: sub?.grade ?? '',
      done: false,
      // Handed in on Canvas (not on paper, in class or nowhere).
      online: types.some(t => t.startsWith('online_')) && !types.includes('online_quiz'),
    } satisfies Assignment
  })
}

/** Plain text from an announcement's HTML. */
export function htmlText(html: string) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim()
}

export function apiAnnouncements(list: unknown, courses: CanvasCourse[]): Announcement[] {
  if (!Array.isArray(list)) return []
  return (list as ApiAnnouncement[]).filter(a => typeof a?.id === 'number').map(a => ({
    id: String(a.id),
    title: a.title || 'Announcement',
    course: courses.find(c => `course_${c.id}` === a.context_code)?.code ?? '',
    posted: a.posted_at ? Date.parse(a.posted_at) || 0 : 0,
    url: a.html_url && /^https:\/\//.test(a.html_url) ? a.html_url : '',
    text: htmlText(a.message ?? '').slice(0, 600),
  })).sort((a, b) => b.posted - a.posted)
}

/** One list from the feed and the API (the API knows more, so it wins), with the done marks. */
export function mergeCanvas(feed: Assignment[], api: Assignment[], done: string[]): Assignment[] {
  const byId = new Map<string, Assignment>()
  for (const a of feed) byId.set(a.id, a)
  for (const a of api) byId.set(a.id, { ...a, url: a.url || byId.get(a.id)?.url || '', course: a.course || byId.get(a.id)?.course || '' })
  const marked = new Set(done)
  return [...byId.values()].map(a => ({ ...a, done: marked.has(a.id) || a.submitted }))
}

/** The note holding assignments added here. */
export function assignmentsNote(notes: Note[]) {
  return notes.find(n => !n.deleted && n.title === ASSIGNMENTS_TITLE && n.folder.toLowerCase() === ASSIGNMENTS_FOLDER.toLowerCase())
}

/** "Math 221: Problem set 4" → the course and the title. */
export function manualLine(text: string) {
  const m = text.match(/^([^:]{1,40}):\s+(.+)$/)
  return m ? { course: m[1].trim(), title: m[2].trim() } : { course: '', title: text.trim() }
}

export function manualAssignments(notes: Note[]): Assignment[] {
  const note = assignmentsNote(notes)
  if (!note) return []
  return visible(note).filter(b => b.kind === 'todo' && b.text.trim()).map(block => ({
    id: `manual:${block.id}`, source: 'manual', kind: 'assignment', ...manualLine(block.text), due: block.due ?? null, url: '',
    points: null, submitted: false, missing: false, grade: '', done: block.checked, noteId: note.id, block,
  }))
}

export type Groups = { overdue: Assignment[]; today: Assignment[]; week: Assignment[]; later: Assignment[]; undated: Assignment[]; done: Assignment[] }

/** Assignments to show, by when they're due. Course events aren't assignments; overdue ones more
 *  than two weeks old and done ones more than a week old drop off. */
export function groupAssignments(list: Assignment[], now: number): Groups {
  const groups: Groups = { overdue: [], today: [], week: [], later: [], undated: [], done: [] }
  const tomorrow = addDays(startOfDay(now), 1)
  const nextWeek = addDays(startOfDay(now), 7)
  for (const a of [...list].sort((x, y) => (x.due ?? Infinity) - (y.due ?? Infinity) || x.title.localeCompare(y.title))) {
    if (a.kind === 'event') continue
    if (a.done) { if (a.due == null || a.due > now - 7 * 86_400_000) groups.done.push(a); continue }
    if (a.due == null) groups.undated.push(a)
    else if (a.due < now) { if (a.due > now - 14 * 86_400_000) groups.overdue.push(a) }
    else if (a.due < tomorrow) groups.today.push(a)
    else if (a.due < nextWeek) groups.week.push(a)
    else groups.later.push(a)
  }
  return groups
}

/** Canvas assignments whose reminder time has come (`hours` before, and an hour before), not
 *  announced yet (marks them). A reminder missed by more than ten minutes isn't sent late. */
export function assignmentRemindersDue(list: Assignment[], now: number, hours: number, seen: Set<string>) {
  const due: Array<{ assignment: Assignment; lead: number }> = []
  const leads = [...new Set([hours * 60, 60].filter(m => m > 0))]
  for (const a of list) {
    // Canvas items and ones added here alike (the checklist reminds at the due time itself).
    if (a.kind === 'event' || a.done || a.due == null || a.due < now) continue
    for (const lead of leads) {
      const at = a.due - lead * 60_000
      const key = `${a.id}:${a.due}:${lead}`
      if (at > now || seen.has(key)) continue
      seen.add(key)
      if (now - at <= 10 * 60_000) due.push({ assignment: a, lead })
    }
  }
  return due
}

/** Canvas items ticked done here that Canvas says weren't handed in, once they're due (up to a
 *  week after): likely forgotten uploads. */
export function notHandedIn(list: Assignment[], now: number) {
  return list.filter(a => a.source === 'canvas' && a.online && a.done && !a.submitted && a.due != null && a.due <= now + 2 * 3_600_000 && now - a.due < 7 * 86_400_000)
}

/** "in 3 hours", "tomorrow 11:59 PM", "2 days ago". */
export function dueText(due: number | null, now: number) {
  if (due == null) return 'No due date'
  const time = new Date(due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000)
  if (due < now) {
    const hours = Math.round((now - due) / 3_600_000)
    return hours < 24 ? `${hours || 'under an'} hour${hours === 1 ? '' : 's'} ago` : `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? '' : 's'} ago`
  }
  if (days === 0) return due - now < 3 * 3_600_000 ? `in ${Math.max(1, Math.round((due - now) / 60_000))} min · ${time}` : `today ${time}`
  if (days === 1) return `tomorrow ${time}`
  if (days < 7) return `${new Date(due).toLocaleDateString([], { weekday: 'long' })} ${time}`
  return new Date(due).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${time}`
}

/** A course's catalog code: "E E 201 Sec05" → "EE 201", "MATH-224-01 Fall 2026" → "MATH 224",
 *  "EE 370L" → "EE 370L"; null when there's none. Spaced single letters are one subject ("E E",
 *  "C E C S"); a number needs three digits, so a section ("Sec05") or a year isn't taken for one. */
export function courseKey(text: string): string | null {
  const m = text.match(/(?:^|[^A-Za-z])((?:[A-Za-z][ .]){1,4}[A-Za-z]|[A-Za-z]{2,6})[\s_.-]*(\d{3})([A-Za-z]?)(?![\dA-Za-z])/)
  return m ? `${m[1].replace(/[ .]/g, '').toUpperCase()} ${m[2]}${m[3].toUpperCase()}` : null
}

/** The Study course name for a Canvas course: its catalog code ("EE 201"), else its name. */
export function studyNameFor(course: Pick<CanvasCourse, 'code' | 'name'>) {
  return courseKey(course.code) ?? courseKey(course.name) ?? course.name.trim().slice(0, 60)
}

/** Whether a Canvas course ("MATH-221-01 Fall 2026") is the Study course ("Math 221"). */
export function courseMatches(study: string, canvas: string) {
  if (!study || !canvas) return false
  const [a, b] = [courseKey(study), courseKey(canvas)]
  if (a && b) return a === b
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return plain(canvas).includes(plain(study)) || plain(study).includes(plain(canvas))
}

/** The names a Study course goes by: its folder name, its catalog code, and its linked Canvas
 *  course's code. An assignment belongs to it when its course matches any of them. */
export type CourseNames = { name: string; code?: string; canvasCode?: string }
export function belongsTo(course: CourseNames, assignmentCourse: string) {
  if (!assignmentCourse) return false
  if (course.canvasCode && assignmentCourse === course.canvasCode) return true
  return [course.name, course.code ?? ''].some(n => n && courseMatches(n, assignmentCourse))
}
