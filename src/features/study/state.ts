import type { Card } from 'ts-fsrs'
import { calendarSave, isTauri, notesCreateMarkdown, notesSave, studyLibrary, studyStateGet, studyStateSet, type CalEvent, type NoteBlock, type StudyLibrary } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { aiPolicyOf, aiPolicyStore, quietUntilStore } from '../../core/exam'
import { notify } from '../../core/notify'
import { createStore } from '../../core/store'
import { eventsStore } from '../calendar/state'
import { between, newId, visible } from '../notes/model'
import { notesStore } from '../notes/state'
import { flashcardsTitle, hasMark, LEECH_LAPSES, setMark, withState, type FlashCard } from './cards'
import { courseFolder, studiedTitle } from './model'
import { readTerm, type Term } from './schedule'
import { problemId, problemsFromState } from './problems'

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
export async function saveReview(card: FlashCard, next: Card) {
  // The block as it is now: another sub-card of the same line may have been reviewed already.
  const block = notesStore.get().find(n => n.id === card.noteId)?.blocks.find(b => b.id === card.block.id) ?? card.block
  let text = withState(block.text, next, card.sub)
  // Forgotten too often: marked so it's easy to find and rewrite.
  if (next.lapses >= LEECH_LAPSES && !hasMark(text, 'leech')) text = setMark(text, 'leech', true)
  const saved = await notesSave({ id: card.noteId, blocks: [{ ...block, text }] })
  notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
}

// ---- Focus timer ----

export type Focus = { course: string; kind: 'focus' | 'break'; startedAt: number; endsAt: number; breakMinutes: number }
export const focusStore = createStore<Focus | null>(null)
let ticker: number | undefined

/** Starts a focus session; when it ends it's kept in the calendar as "Studied <course>". */
export function startFocus(course: string, minutes: number, breakMinutes = 5) {
  const now = Date.now()
  focusStore.set({ course, kind: 'focus', startedAt: now, endsAt: now + minutes * 60_000, breakMinutes })
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
  if (focus?.kind === 'focus' && Date.now() - focus.startedAt >= 5 * 60_000) await logStudy(focus.course, focus.startedAt, Date.now())
}

function tick() {
  const focus = focusStore.get()
  if (!focus) return window.clearInterval(ticker)
  if (Date.now() < focus.endsAt) return
  if (focus.kind === 'focus') {
    void logStudy(focus.course, focus.startedAt, focus.endsAt)
    notify('reminders', 'Focus session done', `${Math.round((focus.endsAt - focus.startedAt) / 60_000)} minutes of ${focus.course}. Take ${focus.breakMinutes} minutes off.`)
    focusStore.set({ ...focus, kind: 'break', startedAt: focus.endsAt, endsAt: focus.endsAt + focus.breakMinutes * 60_000 })
  } else {
    notify('reminders', 'Break over', `Ready for more ${focus.course}?`)
    window.clearInterval(ticker)
    focusStore.set(null)
  }
}

async function logStudy(course: string, start: number, end: number) {
  const event: CalEvent = { id: newId(), title: studiedTitle(course), start, end, allDay: false, location: '', notes: 'Focus session (Study tab)', color: 'green', repeat: null, skip: [], reminder: null, updated: 0, by: '', deleted: false, seq: 0 }
  try {
    const saved = await calendarSave(event)
    eventsStore.set(list => [...list, saved])
  } catch { /* not kept; the timer still worked */ }
}
