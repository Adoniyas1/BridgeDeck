import { useEffect, useMemo } from 'react'
import { listen } from '@tauri-apps/api/event'
import { calendarApple, calendarList, isTauri, type AppleItem, type CalEvent } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { notify } from '../../core/notify'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { dueItems, noteTitle } from '../notes/model'
import { notesStore } from '../notes/state'
import { mergeCanvas, type Assignment } from '../study/canvas'
import { canvasStore } from '../study/canvasStore'
import { addDays, DAY, formatTime, startOfDay, type Item } from './model'
import { occurrences } from './recur'

export const eventsStore = createStore<CalEvent[]>([])
export const eventsLoadedStore = createStore(false)
/** Apple Calendar and Reminders from the Mac for a span of time, and when they were read. */
export const appleStore = createStore<{ items: AppleItem[]; errors: string[]; from: number; to: number; at: number; loading: boolean }>({ items: [], errors: [], from: 0, to: 0, at: 0, loading: false })

export async function refreshEvents() {
  if (!isTauri()) return
  try {
    eventsStore.set(await calendarList())
    eventsLoadedStore.set(true)
  } catch { /* the next refresh tries again */ }
}

/** Reads Apple Calendar for a span (with a week either side) unless it was read recently. */
export async function loadApple(from: number, to: number, force = false) {
  if (!isTauri() || !configStore.get().calendar.showApple) return
  const current = appleStore.get()
  if (current.loading) return
  if (!force && current.from <= from && current.to >= to && Date.now() - current.at < 120_000) return
  const [wideFrom, wideTo] = [addDays(from, -7), addDays(to, 7)]
  appleStore.set({ ...current, loading: true })
  try {
    const answer = await calendarApple(wideFrom, wideTo)
    appleStore.set({ items: answer.items, errors: answer.errors, from: wideFrom, to: wideTo, at: Date.now(), loading: false })
  } catch (error) {
    appleStore.set({ ...appleStore.get(), errors: [String(error)], at: Date.now(), loading: false })
  }
}

/** Everything the calendar shows between two times, soonest first. */
export function itemsBetween(events: CalEvent[], notes: import('../../lib/bridge').Note[], apple: AppleItem[], from: number, to: number, canvas: Assignment[] = []): Item[] {
  const items: Item[] = []
  for (const event of events) {
    if (event.deleted) continue
    for (const o of occurrences(event, from, to)) {
      items.push({ key: `${event.id}:${o.start}`, source: 'event', title: event.title || 'Untitled event', start: o.start, end: o.end, allDay: event.allDay, color: event.color, event })
    }
  }
  for (const { note, block } of dueItems(notes)) {
    const due = block.due ?? 0
    if (due >= from && due < to) items.push({ key: `todo:${block.id}`, source: 'todo', title: block.text.trim() || 'Checklist item', start: due, end: due, allDay: false, color: 'orange', noteId: note.id, calendar: noteTitle(note) })
  }
  for (const a of apple) {
    if (a.start < to && (a.end > a.start ? a.end > from : a.start >= from)) {
      items.push({ key: `apple:${a.from}:${a.id}`, source: 'apple', title: a.title || (a.kind === 'reminder' ? 'Reminder' : 'Event'), start: a.start, end: a.kind === 'reminder' ? a.start : a.end, allDay: a.allDay, color: a.kind === 'reminder' ? 'teal' : 'purple', calendar: `${a.calendar}${a.from ? ` · ${a.from}` : ''}` })
    }
  }
  for (const a of canvas) {
    if (a.due == null || a.due < from || a.due >= to) continue
    const title = a.kind === 'event' ? a.title : `${a.done ? '✓ ' : ''}${a.title}`
    items.push({ key: `${a.id}:${a.due}`, source: 'canvas', title, start: a.due, end: a.due, allDay: false, color: a.kind === 'event' ? 'blue' : 'red', calendar: a.course, checked: a.done, url: a.url })
  }
  return items.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title))
}

export function useItems(from: number, to: number) {
  const events = useStore(eventsStore)
  const notes = useStore(notesStore)
  const apple = useStore(appleStore)
  const config = useStore(configStore)
  const showApple = config.calendar.showApple
  const canvasData = useStore(canvasStore)
  const done = config.canvas.done
  const canvas = useMemo(() => mergeCanvas(canvasData.feed, canvasData.api, done), [canvasData, done])
  useEffect(() => { void loadApple(from, to) }, [from, to, showApple])
  return useMemo(() => itemsBetween(events, notes, showApple ? apple.items : [], from, to, canvas), [events, notes, apple.items, showApple, from, to, canvas])
}

const announced = new Set<string>()

/** Events whose reminder time has come and that haven't been announced (marks them). A reminder
 *  missed by more than ten minutes, for example while the computer slept, isn't sent late. */
export function remindersDue(events: CalEvent[], now: number, seen: Set<string>) {
  const due: Array<{ event: CalEvent; start: number }> = []
  for (const event of events) {
    if (event.deleted || event.reminder == null) continue
    const lead = event.reminder * 60_000
    for (const o of occurrences(event, now - DAY, now + lead + DAY)) {
      const at = o.start - lead
      const key = `${event.id}:${o.start}`
      if (at > now || seen.has(key)) continue
      seen.add(key)
      if (now - at <= 10 * 60_000) due.push({ event, start: o.start })
    }
  }
  return due
}

function checkReminders() {
  for (const { event, start } of remindersDue(eventsStore.get(), Date.now(), announced)) {
    const when = event.allDay ? 'Today' : start <= Date.now() ? `Now · ${formatTime(start)}` : `At ${formatTime(start)}`
    notify('reminders', event.title || 'Event', `${when}${event.location ? ` · ${event.location}` : ''}`)
  }
}

/** Loads events, reloads when another computer's changes arrive, and sends reminders. */
export function CalendarBackground() {
  usePeriodicRefresh(async () => {
    await refreshEvents()
    checkReminders()
    const today = startOfDay(Date.now())
    void loadApple(today, addDays(today, 2))
  }, 60_000, [], 'same')
  useEffect(() => {
    const timer = window.setInterval(checkReminders, 20_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let closed = false
    void listen('calendar-changed', () => void refreshEvents()).then(fn => { if (closed) fn(); else unlisten = fn })
    return () => { closed = true; unlisten?.() }
  }, [])
  return null
}
