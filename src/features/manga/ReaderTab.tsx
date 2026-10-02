import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, BookmarkCheck, ChevronLeft, ChevronRight } from 'lucide-react'
import { mangaBookmark, mangaPages, mangaProgress } from '../../lib/bridge'
import type { DynamicTab } from '../../core/tabs'
import { useStore } from '../../core/store'
import { READ_MODES, pageForKey, seriesTitle, type ReadMode } from './model'
import { mangaStore, openChapter, pageUrl, refreshManga } from './state'

const MODE_KEY = 'bd-manga-mode'
const savedMode = (series: string): ReadMode => { try { return (localStorage.getItem(`${MODE_KEY}:${series}`) as ReadMode) || 'strip' } catch { return 'strip' } }

/** One chapter: a scrolling strip (webtoons) or one page at a time, right to left for manga. */
export default function ReaderTab({ tab, active }: { tab: DynamicTab; active: boolean }) {
  const seriesName = String(tab.params?.series ?? '')
  const chapterId = String(tab.params?.chapter ?? '')
  const askedPage = Number(tab.params?.page ?? 0)
  const imageVersion = String(tab.params?.at ?? '')
  const { library } = useStore(mangaStore)
  const series = library?.series.find(s => s.name === seriesName)
  const chapters = series?.chapters ?? []
  const index = chapters.findIndex(c => c.id === chapterId)
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(askedPage)
  const [error, setError] = useState('')
  const [mode, setModeState] = useState<ReadMode>(() => savedMode(seriesName))
  const [bookmarks, setBookmarks] = useState<number[]>([])
  const strip = useRef<HTMLDivElement>(null)
  const saved = useRef(-1)

  useEffect(() => { if (!library) void refreshManga() }, [library])
  useEffect(() => {
    let cancelled = false
    setError(''); setPages(0); setPage(askedPage); saved.current = -1
    mangaPages(seriesName, chapterId).then(n => { if (!cancelled) setPages(n) }).catch(e => setError(String(e)))
    return () => { cancelled = true }
  }, [seriesName, chapterId, tab.params?.at])
  useEffect(() => { setBookmarks(series?.progress.bookmarks?.[chapterId] ?? []) }, [series, chapterId])

  // Only remember progress once the reader is where it should start (not while pages load in).
  const placed = useRef(false)
  // In strip mode, jump to the asked page once the pages are laid out.
  useEffect(() => {
    placed.current = mode !== 'strip'
    if (mode !== 'strip' || !pages) return
    const t = window.setTimeout(() => {
      strip.current?.querySelector(`[data-page="${askedPage}"]`)?.scrollIntoView({ block: 'start' })
      setPage(askedPage)
      window.setTimeout(() => { placed.current = true }, 300)
    }, 60)
    return () => window.clearTimeout(t)
  }, [pages, mode, askedPage, tab.params?.at])

  // Remember the furthest page reached (debounced).
  useEffect(() => {
    if (!pages || page === saved.current || !placed.current) return
    const t = window.setTimeout(() => { saved.current = page; void mangaProgress(seriesName, chapterId, page, pages).catch(() => undefined) }, 600)
    return () => window.clearTimeout(t)
  }, [page, pages, seriesName, chapterId])

  function setMode(next: ReadMode) {
    setModeState(next)
    try { localStorage.setItem(`${MODE_KEY}:${seriesName}`, next) } catch { /* not remembered */ }
  }
  const go = (n: number) => {
    const target = Math.max(0, Math.min(pages - 1, n))
    setPage(target)
    if (mode === 'strip') strip.current?.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ block: 'start' })
  }
  const openNeighbour = (delta: number) => {
    const next = chapters[index + delta]
    if (next && series) openChapter(seriesName, seriesTitle(series), next.id, 0)
  }

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'b') { void toggleBookmark(); return }
      if (mode === 'strip' && !['Home', 'End'].includes(e.key)) return // the strip scrolls itself
      const next = pageForKey(e.key, mode, page, pages)
      if (next === null) return
      e.preventDefault()
      if (next === page && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === ' ') && page === pages - 1) openNeighbour(1)
      else go(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The page in view while scrolling the strip: the last one whose top has passed 40% of the view.
  function onStripScroll() {
    const box = strip.current
    if (!box || !placed.current) return
    const line = box.getBoundingClientRect().top + box.clientHeight * 0.4
    let current = 0
    for (const img of Array.from(box.querySelectorAll<HTMLElement>('[data-page]'))) {
      if (img.getBoundingClientRect().top <= line) current = Number(img.dataset.page)
      else break
    }
    setPage(current)
  }

  async function toggleBookmark() {
    try { const p = await mangaBookmark(seriesName, chapterId, page); setBookmarks(p.bookmarks?.[chapterId] ?? []) } catch (e) { setError(String(e)) }
  }

  const list = useMemo(() => Array.from({ length: pages }, (_, i) => i), [pages])
  const chapterTitle = chapters[index]?.title ?? chapterId
  const marked = bookmarks.includes(page)

  return <div className="manga-reader" style={{ display: active ? undefined : 'none' }}>
    <div className="book-toolbar">
      <button className="cal-icon" title="Previous chapter" disabled={index <= 0} onClick={() => openNeighbour(-1)}><ChevronLeft size={16} /></button>
      <span className="grow book-title">{series ? seriesTitle(series) : seriesName} · {chapterTitle}</span>
      <button className="cal-icon" title="Next chapter" disabled={index < 0 || index >= chapters.length - 1} onClick={() => openNeighbour(1)}><ChevronRight size={16} /></button>
      <span className="book-page-number">{pages ? `${page + 1} / ${pages}` : '…'}</span>
      <button className="cal-icon" title={marked ? 'Remove bookmark (b)' : 'Bookmark this page (b)'} onClick={() => void toggleBookmark()}>{marked ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}</button>
      {bookmarks.length > 0 && <select className="manga-select" value="" onChange={e => go(Number(e.target.value))}><option value="">Bookmarks</option>{[...bookmarks].sort((a, b) => a - b).map(b => <option key={b} value={b}>Page {b + 1}</option>)}</select>}
      <select className="manga-select" value={mode} onChange={e => setMode(e.target.value as ReadMode)}>{READ_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
    </div>
    {error && <p className="cal-error">{error}</p>}
    <div className="progress-line"><i style={{ width: pages ? `${((page + 1) / pages) * 100}%` : 0 }} /></div>
    {mode === 'strip' ? <div className="manga-strip" ref={strip} onScroll={() => window.requestAnimationFrame(onStripScroll)}>
      {list.map(i => <img key={i} data-page={i} src={pageUrl(seriesName, chapterId, i, imageVersion)} alt={`Page ${i + 1}`} loading="lazy" />)}
      {pages > 0 && <div className="manga-end">
        <p>End of {chapterTitle}</p>
        {index >= 0 && index < chapters.length - 1 ? <button onClick={() => openNeighbour(1)}>Next: {chapters[index + 1].title}</button> : <p className="hint">That's the latest chapter.</p>}
      </div>}
    </div> : <div className={`manga-paged ${mode}`} onClick={e => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const left = e.clientX - r.left < r.width / 2
      go(page + ((left ? mode === 'rtl' : mode !== 'rtl') ? 1 : -1))
    }}>
      {pages > 0 && <img key={page} src={pageUrl(seriesName, chapterId, page, imageVersion)} alt={`Page ${page + 1}`} />}
      {page + 1 < pages && <img className="manga-preload" src={pageUrl(seriesName, chapterId, page + 1, imageVersion)} alt="" />}
      <p className="manga-hint">{mode === 'rtl' ? 'Click the left side for the next page · ← →' : 'Click the right side for the next page · ← →'}</p>
    </div>}
  </div>
}
