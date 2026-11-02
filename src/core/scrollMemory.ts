import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

type Scroller = { scrollTop: number; scrollHeight: number; clientHeight: number }

/** Each tab's place in the window's one scroll area (every tab but the full-height ones scrolls the
 *  same `main`): kept as it scrolls, and put back when the tab is shown again. A tab whose content
 *  is still loading can't reach its place at once, so it's tried again as the content grows, until
 *  the person scrolls themselves. */
export class ScrollMemory {
  private places = new Map<string, number>()
  private tab = ''
  /** The place being restored, while the content is too short to reach it. */
  private pending: number | null = null

  constructor(private el: Scroller) {}

  /** The area scrolled: the place of the tab showing (not while a restore is still catching up). */
  scrolled() {
    if (this.pending === null && this.tab) this.places.set(this.tab, this.el.scrollTop)
  }

  /** The person scrolled (wheel, keys, touch): their place wins over one being restored. */
  userScrolled() {
    this.pending = null
    this.scrolled()
  }

  /** A tab is shown: back to where it was (the top the first time). */
  show(tab: string) {
    this.tab = tab
    this.pending = this.places.get(tab) ?? 0
    this.retry()
  }

  /** Tries the pending place again (the content grew); true once it's reached or can't be. */
  retry(): boolean {
    if (this.pending === null) return true
    const target = this.pending
    this.el.scrollTop = target
    const reachable = this.el.scrollHeight - this.el.clientHeight >= target - 1
    if (reachable) this.pending = null
    return reachable
  }

  /** Gives up on a place the content never grew enough to reach. */
  settle() {
    this.pending = null
    this.scrolled()
  }

  placeOf(tab: string) { return this.places.get(tab) }
}

/** Keeps each tab's scroll place in `area` (off while `enabled` is false: split screen, or a
 *  full-height tab that scrolls itself). */
export function useTabScroll(area: RefObject<HTMLElement>, tab: string, enabled: boolean) {
  const memory = useRef<ScrollMemory | null>(null)
  useEffect(() => {
    const el = area.current
    if (!el) return
    const m = memory.current ?? (memory.current = new ScrollMemory(el))
    const scrolled = () => m.scrolled()
    const user = () => m.userScrolled()
    el.addEventListener('scroll', scrolled, { passive: true })
    for (const e of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) el.addEventListener(e, user, { passive: true })
    return () => {
      el.removeEventListener('scroll', scrolled)
      for (const e of ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const) el.removeEventListener(e, user)
    }
  }, [area])
  useLayoutEffect(() => {
    const el = area.current
    if (!el || !enabled) return
    const m = memory.current ?? (memory.current = new ScrollMemory(el))
    m.show(tab)
    if (m.retry()) return
    // Still loading: try again as the content grows, for a few seconds at most.
    const observer = new ResizeObserver(() => { if (m.retry()) observer.disconnect() })
    for (const child of Array.from(el.children)) observer.observe(child)
    const stop = window.setTimeout(() => { observer.disconnect(); m.settle() }, 4000)
    return () => { observer.disconnect(); window.clearTimeout(stop) }
  }, [area, tab, enabled])
}
