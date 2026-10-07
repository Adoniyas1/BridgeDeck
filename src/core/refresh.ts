import { useEffect, useRef } from 'react'

type Refresher = () => Promise<void> | void

const refreshers = new Set<Refresher>()

/** Runs every feature's refresh (the tab bar's refresh button, and after managed services start). */
export async function refreshAll() {
  await Promise.all([...refreshers].map(async refresh => {
    try { await refresh() } catch { /* each feature reports its own errors */ }
  }))
}

/** How much slower periodic refreshes run while BridgeDeck's window is hidden (in the tray or
 *  minimized): status that nobody sees can wait. */
export const HIDDEN_SLOWDOWN = 5

/** The wait before the next refresh: `intervalMs`, or longer while the window is hidden. */
export function nextDelay(intervalMs: number, hidden: boolean, whileHidden: 'slow' | 'same') {
  return hidden && whileHidden === 'slow' ? intervalMs * HIDDEN_SLOWDOWN : intervalMs
}

/** Registers `refresh` with `refreshAll`, runs it now, and again `intervalMs` after each run ends
 *  while `deps` stay the same (a change in `deps` restarts the cycle, like the effect it replaces).
 *  Runs never overlap (a slow one isn't piled on), and while the window is hidden they come five
 *  times less often, unless `whileHidden` is 'same' (work that sends notifications or serves the
 *  phone page). Showing the window again refreshes at once. */
export function usePeriodicRefresh(refresh: Refresher, intervalMs: number, deps: unknown[], whileHidden: 'slow' | 'same' = 'slow') {
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    const run: Refresher = () => latest.current()
    refreshers.add(run)
    return () => { refreshers.delete(run) }
  }, [])

  useEffect(() => {
    let timer: number | undefined
    let stopped = false
    let running = false
    const run = async () => {
      if (stopped || running) return
      running = true
      window.clearTimeout(timer)
      try { await latest.current() } catch { /* each feature shows its own errors */ } finally { running = false }
      if (!stopped) timer = window.setTimeout(run, nextDelay(intervalMs, document.hidden, whileHidden))
    }
    const onShow = () => { if (!document.hidden && whileHidden === 'slow') void run() }
    void run()
    document.addEventListener('visibilitychange', onShow)
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onShow) }
  }, deps)
}
