import { createStore } from './store'

/** Exam mode: until when, for which course. While it's on, only reminders notify and distracting
 *  sites stay closed in the Browser and TV tabs. Kept across a restart of BridgeDeck. */
export type Exam = { course: string; until: number }

const KEY = 'bridgedeck.exam'

function load(): Exam | null {
  try {
    const exam = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Exam | null
    return exam && typeof exam.until === 'number' && exam.until > Date.now() && typeof exam.course === 'string' ? exam : null
  } catch { return null }
}

export const examStore = createStore<Exam | null>(load())

export function setExam(exam: Exam | null) {
  examStore.set(exam)
  try { if (exam) localStorage.setItem(KEY, JSON.stringify(exam)); else localStorage.removeItem(KEY) } catch { /* kept for this run only */ }
}

export const examOn = (now = Date.now()) => { const exam = examStore.get(); return !!exam && exam.until > now }
