import { useEffect, useRef } from 'react'

type Refresher = () => Promise<void> | void

const refreshers = new Set<Refresher>()

/** Runs every feature's refresh (the tab bar's refresh button, and after managed services start). */
export async function refreshAll() {
  await Promise.all([...refreshers].map(async refresh => {
    try { await refresh() } catch { /* each feature reports its own errors */ }
  }))
}

/** Registers `refresh` with `refreshAll`, runs it now, and again every `intervalMs` while `deps` stay
 *  the same (a change in `deps` restarts the cycle, like the effect it replaces). */
export function usePeriodicRefresh(refresh: Refresher, intervalMs: number, deps: unknown[]) {
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    const run: Refresher = () => latest.current()
    refreshers.add(run)
    return () => { refreshers.delete(run) }
  }, [])

  useEffect(() => {
    void latest.current()
    const timer = window.setInterval(() => void latest.current(), intervalMs)
    return () => window.clearInterval(timer)
  }, deps)
}
