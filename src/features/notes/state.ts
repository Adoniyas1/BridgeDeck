import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isTauri, notesList, type Note } from '../../lib/bridge'
import { notify } from '../../core/notify'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore } from '../../core/store'
import { dueItems, noteTitle, remindersDue, sortNotes } from './model'

export const notesStore = createStore<Note[]>([])
export const notesLoadedStore = createStore(false)
/** Another tab asks Notes to show this note. */
export const openNoteRequest = createStore<string | null>(null)
/** Checklist items past their due time, shown on the tab. */
export const overdueStore = createStore(0)

export async function refreshNotes() {
  if (!isTauri()) return
  try {
    notesStore.set(sortNotes(await notesList()))
    notesLoadedStore.set(true)
  } catch { /* the next refresh tries again */ }
}

const announced = new Set<string>()

function checkReminders() {
  const notes = notesStore.get()
  const now = Date.now()
  for (const { note, block } of remindersDue(notes, now, announced)) notify('reminders', block.text.trim() || 'Checklist item due', noteTitle(note))
  overdueStore.set(dueItems(notes).filter(item => (item.block.due ?? 0) <= now).length)
}

/** Loads notes, reloads when another computer's changes arrive, and announces due items. */
export function NotesBackground() {
  usePeriodicRefresh(async () => { await refreshNotes(); checkReminders() }, 30_000, [], 'same')
  useEffect(() => {
    const timer = window.setInterval(checkReminders, 15_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let closed = false
    void listen('notes-changed', () => void refreshNotes().then(checkReminders)).then(fn => { if (closed) fn(); else unlisten = fn })
    return () => { closed = true; unlisten?.() }
  }, [])
  return null
}
