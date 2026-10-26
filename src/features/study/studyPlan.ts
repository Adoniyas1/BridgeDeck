import { useMemo } from 'react'
import { calendarDelete, calendarSave, type CalEvent } from '../../lib/bridge'
import { createStore, useStore } from '../../core/store'
import { eventsStore, useItems } from '../calendar/state'
import { DAY, formatTime, startOfDay } from '../calendar/model'
import { newId } from '../notes/model'
import { useAssignments, useExams } from './assignments'
import { DEFAULT_PLAN, guessHours, hoursLeft, learnedFactor, missedBlocks, overloadWarnings, PLAN_TAG, planStudy, type PlanOptions, type StudyTask } from './planner'
import { assignmentHours, assignmentTag } from './model'

/**
 * The study plan, worked out the same way wherever it's shown: the planner in Study, the suggestion
 * on Home, and when Mimir is asked to plan the week. What's due in the next four weeks, the hours each
 * needs (learned from how long things really took, less what's done), and blocks in the free time.
 */

const PREFS_KEY = 'bridgedeck.study.planner'
export type PlanPrefs = { options: PlanOptions; hours: Record<string, number>; skip: string[]; extra: StudyTask[] }
const readPrefs = (): PlanPrefs => {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<PlanPrefs>; return { options: { ...DEFAULT_PLAN, ...p.options }, hours: p.hours ?? {}, skip: p.skip ?? [], extra: p.extra ?? [] } } catch { return { options: DEFAULT_PLAN, hours: {}, skip: [], extra: [] } }
}
/** The planner's choices (hours, what to skip, extra tasks), shared by everything that plans. */
export const planPrefsStore = createStore<PlanPrefs>(readPrefs())
export function setPlanPrefs(next: PlanPrefs) {
  planPrefsStore.set(next)
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* this run only */ }
}

const HORIZON = 28 * DAY
const dayText = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

export function useStudyPlan(now: number) {
  const prefs = useStore(planPrefsStore)
  const events = useStore(eventsStore)
  const assignments = useAssignments()
  const exams = useExams()
  // How long things really take (from finished work with focus time), and what's been done already.
  const factor = useMemo(() => learnedFactor(assignments.filter(a => a.done).map(a => ({ kind: a.kind, title: a.title, hours: assignmentHours(events, a.id) }))), [assignments, events])
  const spent = (id: string) => assignmentHours(events, id)
  const missed = useMemo(() => missedBlocks(events, now), [events, now])
  const tasks: StudyTask[] = useMemo(() => [
    ...assignments.filter(a => !a.done && !a.submitted && a.due && a.due > now && a.due < now + HORIZON).map(a => ({ id: a.id, title: a.title, course: a.course, due: a.due!, hours: prefs.hours[a.id] ?? hoursLeft(guessHours(a.kind, a.title) * (factor ?? 1), assignmentHours(events, a.id)) })),
    ...prefs.extra.filter(t => t.due > now),
    // Exams (from the calendar and Canvas) get study time before them too.
    ...exams.filter(e => e.source === 'calendar' && e.start > now && e.start < now + HORIZON).map(e => ({ id: e.id, title: `${e.course} ${e.title}`, course: e.course, due: e.start, hours: prefs.hours[e.id] ?? 6 })),
  ].sort((a, b) => a.due - b.due), [assignments, prefs, now, exams, factor, events])
  const chosen = useMemo(() => tasks.filter(t => !prefs.skip.includes(t.id) && t.hours > 0), [tasks, prefs.skip])
  const last = Math.max(now + DAY, ...chosen.map(t => t.due))
  const items = useItems(startOfDay(now), last + DAY)
  // Busy: anything timed on the calendar (classes, events), except this planner's own blocks.
  const busy = useMemo(() => items.filter(i => !i.allDay && i.source !== 'canvas' && i.source !== 'todo' && !i.event?.notes.includes(PLAN_TAG)), [items])
  const plan = useMemo(() => planStudy(chosen, busy, prefs.options, now), [chosen, busy, prefs.options, now])
  const warnings = useMemo(() => overloadWarnings(chosen, plan.blocks, busy), [chosen, plan, busy])
  const old = useMemo(() => events.filter(e => !e.deleted && e.notes.includes(PLAN_TAG) && e.start > now), [events, now])
  /** Deadlines with study time to plan that no block in the calendar is for yet. */
  const unplanned = useMemo(() => chosen.filter(t => !old.some(e => e.notes.includes(assignmentTag(t.id))) && plan.blocks.some(b => b.task === t.id)), [chosen, old, plan])

  /** Puts the plan in the calendar, replacing the blocks from the last plan still ahead. */
  async function applyPlan(): Promise<{ added: number; replaced: number }> {
    for (const e of old) await calendarDelete(e.id)
    const saved: CalEvent[] = []
    for (const b of plan.blocks) {
      const t = chosen.find(x => x.id === b.task)
      saved.push(await calendarSave({ id: newId(), title: `Study: ${b.title}`, start: b.start, end: b.end, allDay: false, location: '', notes: `${t?.course ? `${t.course} · ` : ''}due ${t ? `${dayText(t.due)} ${formatTime(t.due)}` : ''}${t ? ` ${assignmentTag(t.id)}` : ''}\n${PLAN_TAG}`, color: 'purple', repeat: null, skip: [], reminder: 10, updated: 0, by: '', deleted: false, seq: 0 }))
    }
    const gone = new Set(old.map(e => e.id))
    eventsStore.set(list => [...list.filter(e => !gone.has(e.id) && !saved.some(s => s.id === e.id)), ...saved])
    return { added: saved.length, replaced: old.length }
  }

  return { prefs, setPrefs: setPlanPrefs, tasks, chosen, plan, warnings, old, unplanned, factor, spent, missed, applyPlan }
}
