import type { Card } from 'ts-fsrs'
import { examSites, calendarSave, isTauri, notesCreateMarkdown, notesSave, studyLibrary, studyReviewLog, studyStateGet, studyStateSet, type CalEvent, type NoteBlock, type StudyLibrary } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { aiPolicyOf, aiPolicyStore, examOn, quietUntilStore } from '../../core/exam'
import { notify } from '../../core/notify'
import { createStore } from '../../core/store'
import { eventsStore } from '../calendar/state'
import { between, newId, visible } from '../notes/model'
import { notesStore } from '../notes/state'
import { flashcardsTitle, hasMark, LEECH_LAPSES, setMark, withState, type FlashCard } from './cards'
import { assignmentTag, courseFolder, studiedTitle } from './model'
import { readTerm, type Term } from './schedule'
import { readMistakes, type Mistake, type Prediction } from './mistakes'
import { nextRating, problemId, problemsFromState, ratingsFromState, type Problem, type RatedProblem, type Rating } from './problems'

export const libraryStore = createStore<{ library: StudyLibrary | null; error: string }>({ library: null, error: '' })
/** The semester's dates and breaks (Study → courses → Semester). */
export const termStore = createStore<Term | null>(null)

/** Reads the course folders (in the synced folder, so books added on the other computer appear)
 *  and the semester's dates. */
export async function refreshLibrary() {
  if (!isTauri()) return
  try {
    const library = await studyLibrary(configStore.get().syncthing.sharedFolderPath)
    libraryStore.set({ library, error: '' })
    aiPolicyStore.set(Object.fromEntries(library.courses.map(c => [c.name, aiPolicyOf(c.info)])))
    const term = readTerm(JSON.stringify((await studyStateGet('term').catch(() => ({} as Record<string, unknown>))).term ?? {}))
    if (JSON.stringify(term) !== JSON.stringify(termStore.get())) termStore.set(term)
  } catch (e) {
    libraryStore.set(current => ({ ...current, error: String(e) }))
  }
}

/** Homework problems ticked off, by assignment (study/problems.ts). Each computer keeps its own
 *  ticks and they're merged (src-tauri/src/study_state.rs), so ticking on both doesn't conflict. */
export const problemsStore = createStore<Record<string, string[]>>({})
let problemsLoaded = false
export async function loadProblems() {
  if (problemsLoaded || !isTauri()) return
  problemsLoaded = true
  problemsStore.set(problemsFromState(await studyStateGet('problems').catch(() => ({}))))
}
export function tickProblem(assignment: string, key: string) {
  const ticked = !(problemsStore.get()[assignment] ?? []).includes(key)
  problemsStore.set(all => {
    const list = all[assignment] ?? []
    const next = { ...all, [assignment]: ticked ? [...list, key] : list.filter(k => k !== key) }
    if (!next[assignment].length) delete next[assignment]
    return next
  })
  if (isTauri()) void studyStateSet('problems', { [problemId(assignment, key)]: ticked ? true : null }).catch(() => undefined)
}

/** Problems marked as needing help or stuck, from both computers. */
export const ratingsStore = createStore<RatedProblem[]>([])
let ratingsLoaded = false
export async function loadRatings(force = false) {
  if ((ratingsLoaded && !force) || !isTauri()) return
  ratingsLoaded = true
  ratingsStore.set(ratingsFromState(await studyStateGet('ratings').catch(() => ({}))))
}
/** Moves a problem's rating on (none → help → stuck → none). */
export function rateProblem(assignment: { id: string; title: string; course: string }, problem: Problem, to?: Rating | null) {
  const id = problemId(assignment.id, problem.key)
  const current = ratingsStore.get().find(r => r.id === id)
  const next = to !== undefined ? to : nextRating(current?.rating)
  const entry = next ? { id, rating: next, course: assignment.course, assignment: assignment.title, section: problem.section, number: problem.number, at: Date.now() } : null
  ratingsStore.set(list => ratingsFromState(Object.fromEntries([...list.filter(r => r.id !== id), ...(entry ? [entry] : [])].map(r => [r.id, r]))))
  if (isTauri()) void studyStateSet('ratings', { [id]: entry }).catch(() => undefined)
}

/** Mistakes from graded work and the scores expected before handing in (study/mistakes.ts). */
export const mistakesStore = createStore<{ mistakes: Mistake[]; predictions: Prediction[] }>({ mistakes: [], predictions: [] })
let mistakesLoaded = false
export async function loadMistakes(force = false) {
  if ((mistakesLoaded && !force) || !isTauri()) return
  mistakesLoaded = true
  mistakesStore.set(readMistakes(await studyStateGet('mistakes').catch(() => ({}))))
}
async function putMistakes(changes: Record<string, unknown>) {
  await studyStateSet('mistakes', changes)
  mistakesLoaded = false
  await loadMistakes()
}
export const addMistake = (course: string, assignment: string, text: string) => putMistakes({ [`m:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`]: { course, assignment, text: text.trim(), at: Date.now() } })
export const removeMistake = (id: string) => putMistakes({ [id]: null })
export const predictScore = (assignmentId: string, course: string, assignment: string, predicted: number | null) => putMistakes({ [`p:${assignmentId}`]: predicted == null ? null : { course, assignment, predicted, at: Date.now() } })

export async function saveTerm(term: Term | null) {
  termStore.set(term)
  await studyStateSet('term', { term: term ?? null })
}

// ---- Flashcards ----

/** Adds card lines to the course's flashcard note, making the note if needed. */
export async function addCards(course: string, lines: string[]) {
  const folder = courseFolder(course)
  const existing = notesStore.get().find(n => !n.deleted && n.title === flashcardsTitle(course) && n.folder.toLowerCase() === folder.toLowerCase())
  if (!existing) {
    const created = await notesCreateMarkdown(flashcardsTitle(course), folder, 'note', lines.map(l => `- ${l}`).join('\n'))
    notesStore.set(list => [created, ...list])
    return
  }
  const shown = visible(existing)
  let pos = shown[shown.length - 1]?.pos ?? ''
  const blocks: NoteBlock[] = lines.map(text => {
    pos = between(pos, '')
    return { id: newId(), kind: 'li', text, checked: false, due: null, pos, updated: 0, by: '', deleted: false }
  })
  const saved = await notesSave({ id: existing.id, blocks })
  notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
}

/** Set from Home: review the due cards of every course, mixed. */
export const reviewAllRequest = createStore(0)

/** Rewrites, removes, or marks a card line in its note. */
export async function changeCardLine(noteId: string, blockId: string, text: string | null) {
  const block = notesStore.get().find(n => n.id === noteId)?.blocks.find(b => b.id === blockId)
  if (!block) throw new Error('That card is gone')
  const saved = await notesSave(text === null ? { id: noteId, removed: [blockId] } : { id: noteId, blocks: [{ ...block, text }] })
  notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
}

/** Saves a card's new review state into its note line. */
export async function saveReview(card: FlashCard, next: Card, grade?: number, ms = 0) {
  // The block as it is now: another sub-card of the same line may have been reviewed already.
  const block = notesStore.get().find(n => n.id === card.noteId)?.blocks.find(b => b.id === card.block.id) ?? card.block
  let text = withState(block.text, next, card.sub)
  // Forgotten too often: marked so it's easy to find and rewrite.
  if (next.lapses >= LEECH_LAPSES && !hasMark(text, 'leech')) text = setMark(text, 'leech', true)
  const saved = await notesSave({ id: card.noteId, blocks: [{ ...block, text }] })
  notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
  // The review log, for tuning FSRS to how this person remembers; losing an entry is harmless.
  if (grade) void studyReviewLog({ card: card.id, at: Date.now(), grade, ms: Math.min(ms, 3_600_000) }).catch(() => {})
}

// ---- Focus timer ----

export type Focus = { course: string; kind: 'focus' | 'break'; startedAt: number; endsAt: number; breakMinutes: number; /** What it's for. */ assignment?: { id: string; title: string }; /** Distracting sites closed while focusing. */ block?: boolean }
export const focusStore = createStore<Focus | null>(null)
let ticker: number | undefined

/** Starts a focus session; when it ends it's kept in the calendar as "Studied <course>". */
export function startFocus(course: string, minutes: number, breakMinutes = 5, opts: { assignment?: { id: string; title: string }; block?: boolean } = {}) {
  const now = Date.now()
  focusStore.set({ course, kind: 'focus', startedAt: now, endsAt: now + minutes * 60_000, breakMinutes, ...opts })
  if (opts.block && isTauri()) void examSites(configStore.get().study.examBlock).catch(() => undefined)
  quietUntilStore.set(configStore.get().study.quietFocus ? now + minutes * 60_000 : 0)
  window.clearInterval(ticker)
  ticker = window.setInterval(tick, 1000)
}

/** Stops early; a focus session of 5 minutes or more is still kept. */
export async function stopFocus() {
  const focus = focusStore.get()
  window.clearInterval(ticker)
  focusStore.set(null)
  quietUntilStore.set(0)
  unblock(focus)
  if (focus?.kind === 'focus' && Date.now() - focus.startedAt >= 5 * 60_000) await logStudy(focus.course, focus.startedAt, Date.now(), focus.assignment)
}

function tick() {
  const focus = focusStore.get()
  if (!focus) return window.clearInterval(ticker)
  if (Date.now() < focus.endsAt) return
  if (focus.kind === 'focus') {
    void logStudy(focus.course, focus.startedAt, focus.endsAt, focus.assignment)
    unblock(focus)
    notify('reminders', 'Focus session done', `${Math.round((focus.endsAt - focus.startedAt) / 60_000)} minutes of ${focus.course}. Take ${focus.breakMinutes} minutes off.`)
    focusStore.set({ ...focus, kind: 'break', startedAt: focus.endsAt, endsAt: focus.endsAt + focus.breakMinutes * 60_000 })
  } else {
    notify('reminders', 'Break over', `Ready for more ${focus.course}?`)
    window.clearInterval(ticker)
    focusStore.set(null)
  }
}

/** Sites closed for a focus session open again (unless an exam is on, which keeps them closed). */
function unblock(focus: Focus | null) {
  if (focus?.block && !examOn() && isTauri()) void examSites([]).catch(() => undefined)
}

async function logStudy(course: string, start: number, end: number, assignment?: { id: string; title: string }) {
  const event: CalEvent = { id: newId(), title: studiedTitle(course), start, end, allDay: false, location: '', notes: `Focus session (Study tab)${assignment ? `\nFor: ${assignment.title} ${assignmentTag(assignment.id)}` : ''}`, color: 'green', repeat: null, skip: [], reminder: null, updated: 0, by: '', deleted: false, seq: 0 }
  try {
    const saved = await calendarSave(event)
    eventsStore.set(list => [...list, saved])
  } catch { /* not kept; the timer still worked */ }
}
