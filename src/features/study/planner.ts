/** The study planner: spreads the hours each deadline needs over the free time before it, around
 *  classes and calendar events, a few hours a day at most, and suggests them as calendar blocks. */

import { startOfDay } from '../calendar/model'

export type StudyTask = { id: string; title: string; course: string; due: number; hours: number }
export type StudyBlock = { task: string; title: string; start: number; end: number }
export type PlanOptions = {
  /** Study between these hours of the day (e.g. 9 and 22). */
  fromHour: number
  toHour: number
  /** Most study per day, in hours. */
  maxPerDay: number
  /** One block, in minutes. */
  blockMinutes: number
  /** Finish this long before a deadline (ms). */
  bufferMs: number
}

export const DEFAULT_PLAN: PlanOptions = { fromHour: 9, toHour: 22, maxPerDay: 4, blockMinutes: 60, bufferMs: 2 * 3_600_000 }
const STEP = 30 * 60_000
const HOUR = 3_600_000

/** Marks the calendar events the planner made, so planning again can replace them. */
export const PLAN_TAG = '[BridgeDeck study plan]'

/** A first guess at how long something takes. */
export function guessHours(kind: string, title: string): number {
  // "(~3h)", written when it was added in plain words.
  const said = title.match(/~\s*(\d+(?:\.\d+)?)\s*h/i)
  if (said) return Math.min(40, Math.max(0.25, Number(said[1])))
  if (/\b(final|midterm|exam)\b/i.test(title)) return 6
  if (kind === 'quiz' || /\bquiz\b/i.test(title)) return 2
  if (/\b(lab|project|report|essay|paper)\b/i.test(title)) return 4
  if (kind === 'discussion') return 1
  return 2
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end

/** The study blocks for the tasks (earliest deadline first), and the hours that didn't fit. */
export function planStudy(tasks: StudyTask[], busy: Array<{ start: number; end: number }>, opts: PlanOptions = DEFAULT_PLAN, now = Date.now()): { blocks: StudyBlock[]; short: Record<string, number> } {
  const len = opts.blockMinutes * 60_000
  const blocks: StudyBlock[] = []
  const short: Record<string, number> = {}
  const load = new Map<number, number>() // day → ms planned
  const taken = [...busy]
  const firstStart = Math.ceil(now / STEP) * STEP
  for (const t of [...tasks].sort((a, b) => a.due - b.due)) {
    const last = t.due - opts.bufferMs
    const days: number[] = []
    for (let d = startOfDay(firstStart); d < last; d = startOfDay(d + 36 * HOUR)) days.push(d)
    let need = Math.round((t.hours * HOUR) / len)
    while (need > 0) {
      // The least-loaded day that still has room; among those, the one farthest from this task's
      // other days (spaced out), then the later one (a review close to the deadline).
      const mine = blocks.filter(b => b.task === t.id).map(b => startOfDay(b.start))
      const gap = (d: number) => (mine.length ? Math.min(...mine.map(m => Math.abs(m - d))) : Infinity)
      const order = days.filter(d => (load.get(d) ?? 0) + len <= opts.maxPerDay * HOUR).sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || gap(b) - gap(a) || b - a)
      let placed = false
      for (const d of order) {
        const open = Math.max(d + opts.fromHour * HOUR, firstStart)
        const close = Math.min(d + opts.toHour * HOUR, last)
        for (let s = Math.ceil(open / STEP) * STEP; s + len <= close; s += STEP) {
          const slot = { start: s, end: s + len }
          if (taken.some(b => overlaps(b, slot))) continue
          blocks.push({ task: t.id, title: t.title, ...slot })
          taken.push(slot)
          load.set(d, (load.get(d) ?? 0) + len)
          placed = true
          break
        }
        if (placed) break
      }
      if (!placed) break
      need--
    }
    if (need > 0) short[t.id] = (need * len) / HOUR
  }
  return { blocks: blocks.sort((a, b) => a.start - b.start), short }
}

/** How long assignments really take compared with the first guess, from finished ones with focus
 *  time logged (at least three): the median of actual ÷ guess, between 0.5 and 2.5; null without
 *  enough to go on. */
export function learnedFactor(finished: Array<{ kind: string; title: string; hours: number }>): number | null {
  const ratios = finished.filter(f => f.hours >= 0.5).map(f => f.hours / guessHours(f.kind, f.title)).sort((a, b) => a - b)
  if (ratios.length < 3) return null
  const mid = ratios.length / 2
  const median = ratios.length % 2 ? ratios[Math.floor(mid)] : (ratios[mid - 1] + ratios[mid]) / 2
  return Math.min(2.5, Math.max(0.5, Math.round(median * 10) / 10))
}

/** Hours still needed: the estimate less the time already spent, in half hours. */
export const hoursLeft = (estimate: number, spent: number) => Math.max(0, Math.round((estimate - spent) * 2) / 2)

/** Study blocks from the plan in the last week that passed without any study logged during them
 *  (no "Studied …" event overlapping): missed, so planning again fits them in. */
export function missedBlocks(events: Array<{ title: string; start: number; end: number; notes: string; deleted: boolean }>, now: number) {
  const studied = events.filter(e => !e.deleted && e.title.startsWith('Studied '))
  return events.filter(e => !e.deleted && e.notes.includes(PLAN_TAG) && e.end < now && e.start > now - 7 * 86_400_000 && !studied.some(s => overlaps(s, e)))
}

export type Warning = { kind: 'late' | 'long' | 'cluster'; text: string }

/** What looks like too much: study blocks late at night (after 11 pm or before 7 am), days with
 *  more than `maxDayHours` of classes, events and study together, and three or more deadlines or
 *  exams within 48 hours (to start some of them sooner). */
export function overloadWarnings(tasks: StudyTask[], blocks: StudyBlock[], busy: Array<{ start: number; end: number }>, maxDayHours = 10): Warning[] {
  const out: Warning[] = []
  const late = blocks.filter(b => { const s = new Date(b.start).getHours(), e = new Date(b.end - 1).getHours(); return e >= 23 || s < 7 })
  if (late.length) out.push({ kind: 'late', text: `${late.length} block${late.length === 1 ? ' is' : 's are'} late at night; sleep helps more than late study. Set the planner to stop earlier.` })
  const perDay = new Map<number, number>()
  for (const x of [...blocks, ...busy]) { const d = startOfDay(x.start); perDay.set(d, (perDay.get(d) ?? 0) + (x.end - x.start) / 3_600_000) }
  for (const [day, hours] of [...perDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (hours > maxDayHours) out.push({ kind: 'long', text: `${new Date(day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} has ${Math.round(hours)} hours of classes, events and study: move a block to a lighter day.` })
  }
  const sorted = [...tasks].sort((a, b) => a.due - b.due)
  for (let i = 0; i < sorted.length; i++) {
    const group = sorted.filter(t => t.due >= sorted[i].due && t.due - sorted[i].due <= 48 * 3_600_000)
    if (group.length >= 3) {
      out.push({ kind: 'cluster', text: `${group.length} things due within 48 hours (${group.map(t => t.title).join(', ')}): start ${group.length > 3 ? 'some' : 'one'} of them a few days early.` })
      i += group.length - 1
    }
  }
  return out
}
