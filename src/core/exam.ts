import { createStore } from './store'
import { isTauri, studyStateGet, studyStateSet } from '../lib/bridge'
import { setNotice } from './notice'

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

/** Until when a focus session (Study) keeps Mail, Messages and AI notifications quiet; 0 when not. */
export const quietUntilStore = createStore(0)

function keep(exam: Exam | null) {
  examStore.set(exam)
  try { if (exam) localStorage.setItem(KEY, JSON.stringify(exam)); else localStorage.removeItem(KEY) } catch { /* kept for this run only */ }
}

/** Starts or ends exam mode here and, through the synced study state, on the other computer too. */
export function setExam(exam: Exam | null) {
  keep(exam)
  if (isTauri()) void studyStateSet('exam', { exam: exam ?? null }).catch(() => undefined)
}

/** Picks up exam mode started or ended on the other computer. */
export async function loadSharedExam() {
  if (!isTauri()) return
  const state = await studyStateGet('exam').catch(() => null)
  if (!state) return
  const raw = state.exam as Partial<Exam> | undefined
  const shared = raw && typeof raw.until === 'number' && raw.until > Date.now() ? { course: String(raw.course ?? ''), until: raw.until } : null
  const mine = examStore.get()
  if (JSON.stringify(shared) !== JSON.stringify(mine && mine.until > Date.now() ? mine : null)) keep(shared)
}

export const examOn = (now = Date.now()) => { const exam = examStore.get(); return !!exam && exam.until > now }

/** Each course's AI rule: 'none' (no AI for it), 'hints' (the default: Mimir teaches by hints), or
 *  'full' (full worked answers are fine). Filled in from the courses' settings. */
export type AiPolicy = 'none' | 'hints' | 'full'
export const aiPolicyStore = createStore<Record<string, AiPolicy>>({})
export const aiPolicyOf = (info: { aiPolicy?: unknown }): AiPolicy => info.aiPolicy === 'none' || info.aiPolicy === 'full' ? info.aiPolicy : 'hints'

/** Whether AI help may be used now (for a course, when given). Says why not when it can't. */
export function aiAllowed(course?: string | null, now = Date.now()): boolean {
  const exam = examStore.get()
  if (exam && exam.until > now) {
    setNotice(`Exam mode is on${exam.course ? ` for ${exam.course}` : ''}: AI help is off until ${new Date(exam.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`)
    return false
  }
  if (course && aiPolicyStore.get()[course] === 'none') {
    setNotice(`AI help is off for ${course} (its course settings say no AI).`)
    return false
  }
  return true
}

/** "Study/EE 310" (a note folder) → "EE 310". */
export const courseOfFolder = (folder?: string | null) => folder?.startsWith('Study/') ? folder.slice(6).split('/')[0] : null
