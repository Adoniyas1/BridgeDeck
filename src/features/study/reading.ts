import { isTauri, studyStateGet, studyStateSet } from '../../lib/bridge'

/** Where a book was left: a PDF's page or an EPUB's place (CFI), and when. */
export type Place = { page?: number; cfi?: string; at: number }

const key = (course: string, file: string) => `${course}/${file}`
const atKey = (course: string, file: string) => `bd-place-at:${key(course, file)}`

/** The newer of two places (either may be missing). */
export function newestPlace(a: Place | null | undefined, b: Place | null | undefined): Place | null {
  if (!a) return b ?? null
  if (!b) return a
  return b.at > a.at ? b : a
}

function asPlace(value: unknown): Place | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const at = typeof v.at === 'number' ? v.at : 0
  const page = typeof v.page === 'number' && v.page >= 1 ? Math.floor(v.page) : undefined
  const cfi = typeof v.cfi === 'string' && v.cfi.length < 2000 ? v.cfi : undefined
  return page || cfi ? { page, cfi, at } : null
}

/** Where the book was left, on this computer or the other one, whichever was later. `local` is
 *  this computer's own memory of it (kept for opening instantly and when offline). */
export async function placeOf(course: string, file: string, local: Omit<Place, 'at'> | null): Promise<Place | null> {
  let localAt = 0
  try { localAt = Number(localStorage.getItem(atKey(course, file))) || 0 } catch { /* not remembered */ }
  const mine = local && (local.page || local.cfi) ? { ...local, at: localAt } : null
  if (!isTauri()) return mine
  const synced = asPlace((await studyStateGet('reading').catch(() => ({} as Record<string, unknown>)))[key(course, file)])
  return newestPlace(mine, synced)
}

// Places to save to the synced study state: at most every 30 s, and when the window is hidden or
// closed, so turning pages doesn't rewrite a synced file all the time.
const pending = new Map<string, Place>()
let timer: number | undefined

export function flushPlaces() {
  window.clearTimeout(timer)
  timer = undefined
  if (!pending.size || !isTauri()) return
  const changes = Object.fromEntries(pending)
  pending.clear()
  void studyStateSet('reading', changes).catch(() => undefined)
}

/** Remembers where a book is now (the caller keeps its own instant copy on this computer). */
export function rememberPlace(course: string, file: string, place: Omit<Place, 'at'>) {
  const at = Date.now()
  try { localStorage.setItem(atKey(course, file), String(at)) } catch { /* not remembered */ }
  pending.set(key(course, file), { ...place, at })
  timer ??= window.setTimeout(flushPlaces, 30_000)
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPlaces)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPlaces() })
}
