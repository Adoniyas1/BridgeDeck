import type { MangaSeries } from '../../lib/bridge'

/** Shown name: the title from its details, else the folder name. */
export const seriesTitle = (s: MangaSeries) => s.meta.title?.trim() || s.name

/** Where to carry on: the chapter after the last finished one, or the one in progress. */
export function continueAt(s: MangaSeries): { chapter: string; page: number } | null {
  if (!s.chapters.length) return null
  const done = s.progress.chapters ?? {}
  const last = s.progress.last ? s.chapters.findIndex(c => c.id === s.progress.last) : -1
  if (last >= 0) {
    const state = done[s.chapters[last].id]
    if (state && !state.done) return { chapter: s.chapters[last].id, page: state.page }
    if (last + 1 < s.chapters.length) return { chapter: s.chapters[last + 1].id, page: 0 }
    return { chapter: s.chapters[last].id, page: 0 }
  }
  const first = s.chapters.find(c => !done[c.id]?.done) ?? s.chapters[0]
  return { chapter: first.id, page: done[first.id]?.page ?? 0 }
}

export function readCount(s: MangaSeries) {
  return s.chapters.filter(c => s.progress.chapters?.[c.id]?.done).length
}

/** Recently read first, then by title. */
export function sortSeries(list: MangaSeries[]) {
  return [...list].sort((a, b) => (b.progress.at ?? 0) - (a.progress.at ?? 0) || seriesTitle(a).localeCompare(seriesTitle(b)))
}

export type ReadMode = 'strip' | 'ltr' | 'rtl'
export const READ_MODES: Array<{ id: ReadMode; label: string }> = [
  { id: 'strip', label: 'Scroll (webtoon)' },
  { id: 'rtl', label: 'Pages, right to left (manga)' },
  { id: 'ltr', label: 'Pages, left to right' },
]

/** The next page for a key press in a mode: in right-to-left reading the left arrow goes forward. */
export function pageForKey(key: string, mode: ReadMode, page: number, pages: number): number | null {
  const forward = ['ArrowDown', 'PageDown', ' ', 'j']
  const back = ['ArrowUp', 'PageUp', 'k']
  if (mode === 'rtl') { forward.push('ArrowLeft'); back.push('ArrowRight') } else { forward.push('ArrowRight'); back.push('ArrowLeft') }
  if (key === 'Home') return 0
  if (key === 'End') return pages - 1
  if (forward.includes(key)) return Math.min(pages - 1, page + 1)
  if (back.includes(key)) return Math.max(0, page - 1)
  return null
}
