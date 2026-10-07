import type { Card } from 'ts-fsrs'
import { calendarSave, isTauri, notesCreateMarkdown, notesSave, studyLibrary, studyStateRead, studyStateWrite, type CalEvent, type NoteBlock, type StudyLibrary } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { notify } from '../../core/notify'
import { createStore } from '../../core/store'
import { eventsStore } from '../calendar/state'
import { between, newId, visible } from '../notes/model'
import { notesStore } from '../notes/state'
import { flashcardsTitle, withState, type FlashCard } from './cards'
import { courseFolder, studiedTitle } from './model'
import { readTerm, type Term } from './schedule'

export const libraryStore = createStore<{ library: StudyLibrary | null; error: string }>({ library: null, error: '' })
/** The semester's dates and breaks (Study → courses → Semester). */
export const termStore = createStore<Term | null>(null)

/** Reads the course folders (in the synced folder, so books added on the other computer appear)
 *  and the semester's dates. */
export async function refreshLibrary() {
  if (!isTauri()) return
  try {
    libraryStore.set({ library: await studyLibrary(configStore.get().syncthing.sharedFolderPath), error: '' })
    const term = readTerm(await studyStateRead('term').catch(() => ''))
    if (JSON.stringify(term) !== JSON.stringify(termStore.get())) termStore.set(term)
  } catch (e) {
    libraryStore.set(current => ({ ...current, error: String(e) }))
  }
}

export async function saveTerm(term: Term | null) {
  termStore.set(term)
  await studyStateWrite('term', JSON.stringify(term ?? {}))
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

/** Saves a card's new review state into its note line. */
export async function saveReview(card: FlashCard, next: Card) {
  const saved = await notesSave({ id: card.noteId, blocks: [{ ...card.block, text: withState(card.block.text, next) }] })
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
  window.clearInterval(ticker)
  ticker = window.setInterval(tick, 1000)
}

/** Stops early; a focus session of 5 minutes or more is still kept. */
export async function stopFocus() {
  const focus = focusStore.get()
  window.clearInterval(ticker)
  focusStore.set(null)
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
