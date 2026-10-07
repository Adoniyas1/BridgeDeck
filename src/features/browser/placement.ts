import { useEffect, type RefObject } from 'react'
import { browserHide, browserShow, isTauri } from '../../lib/bridge'

/** Keeps a native page (browser.rs) laid over `area` while `show` is true, and hidden otherwise.
 *  `take` hands over an address to go to once (null: stay where it is). */
export function usePagePlacement(page: string, show: boolean, area: RefObject<HTMLElement>, take: () => string | null, onError: (e: string) => void, deps: unknown[] = []) {
  useEffect(() => {
    if (!isTauri()) return
    const el = area.current
    if (!show || !el) { void browserHide(page).catch(() => undefined); return }
    let last = ''
    const place = () => {
      const r = el.getBoundingClientRect()
      const go = take()
      const at = [r.left, r.top, r.width, r.height].map(Math.round).join(',')
      if (at === last && !go) return
      last = at
      void browserShow(page, go, r.left, r.top, r.width, r.height).catch(e => onError(String(e)))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    // The area can move without resizing (a notice above it comes or goes).
    const timer = window.setInterval(place, 400)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.clearInterval(timer); void browserHide(page).catch(() => undefined) }
  }, [page, show, ...deps])
}
