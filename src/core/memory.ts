import { createStore } from './store'

/**
 * Freeing memory on a small computer (an 8 GB Mac): when memory runs short, tabs hidden for a long
 * time are unloaded and load again when you go back to them. Only tabs that lose nothing by it:
 * pages without work running in them (recording, music, mail, the browser and Mimir stay) and
 * books, which reopen at the page they were on.
 */

/** Hidden this long, a tab may be unloaded while memory is short. */
export const IDLE_UNLOAD_MS = 20 * 60_000
/** Memory this full (percent in use) counts as short. */
export const TIGHT_PERCENT = 85
/** Open tabs of these kinds can be unloaded (they reopen where they were). */
export const UNLOADABLE_KINDS = new Set(['study-book'])

/** Bumped to unload every hidden tab that can be, now (Settings → Activity). */
export const unloadNowStore = createStore(0)
/** How many tabs are unloaded now, for Settings. */
export const unloadedStore = createStore<string[]>([])

/** The tabs to unload: loaded, hidden (not in `shown`), and hidden for at least `idleMs`. */
export function idleToUnload(candidates: string[], shown: Array<string | null>, hiddenSince: Record<string, number>, now: number, idleMs: number): string[] {
  return candidates.filter(id => !shown.includes(id) && now - (hiddenSince[id] ?? now) >= idleMs)
}
