import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BookMarked, ChevronDown, ChevronLeft, ChevronRight, Moon, MoveHorizontal, Sun, Highlighter, Layers, MessageCircleQuestion, ListChecks, ListTree, Minus, Plus } from 'lucide-react'
import 'pdfjs-dist/web/pdf_viewer.css'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { notesCreateMarkdown, notesSave, openPath, type NoteBlock } from '../../lib/bridge'
import type { DynamicTab } from '../../core/tabs'
import { activateTab } from '../../core/tabs'
import { between, newId, visible } from '../notes/model'
import { notesStore, openNoteRequest, refreshNotes } from '../notes/state'
import { useStore } from '../../core/store'
import { bookLink, chaptersTitle, courseFolder, currentPath, highlightsByPage, highlightsTitle, inHighlight, outlineParents, outlineToMarkdown, type OutlineItem } from './model'
import { addCards, libraryStore } from './state'
import { cardLine } from './cards'
import { askChatGPT, passagePrompt } from '../../core/chatgpt'
import { loadBook, pdfjs } from './pdf'
import EpubTab from './EpubTab'

const NO_MARKS: string[] = []
const pageKey = (course: string, file: string) => `bd-book-page:${course}/${file}`
function savedPage(course: string, file: string) {
  try { return Number(localStorage.getItem(pageKey(course, file))) || 1 } catch { return 1 }
}
function savePage(course: string, file: string, page: number) {
  try { localStorage.setItem(pageKey(course, file), String(page)) } catch { /* private window: not remembered */ }
}

type Outline = Array<{ title: string; dest: unknown; items: Outline }>

async function resolveOutline(doc: PDFDocumentProxy, items: Outline | null): Promise<OutlineItem[]> {
  if (!items) return []
  return Promise.all(items.map(async item => {
    let page: number | null = null
    try {
      const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest as unknown[] | null
      if (Array.isArray(dest) && dest[0]) page = (await doc.getPageIndex(dest[0] as never)) + 1
    } catch { /* a broken link in the book: no page */ }
    return { title: item.title, page, items: await resolveOutline(doc, item.items) }
  }))
}

/** One page: drawn when it comes near the screen, with a text layer so passages can be selected. */
function Page({ doc, number, scale, size, marks }: { doc: PDFDocumentProxy; number: number; scale: number; size: { width: number; height: number }; marks: string[] }) {
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  // Pages can differ in size (a cover, a fold-out); until this one is read, assume the first page's.
  const [own, setOwn] = useState<{ width: number; height: number } | null>(null)
  const shown = own ?? size
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) setNear(entry.isIntersecting)
    }, { rootMargin: '600px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el) return
    if (!near) { el.replaceChildren(); return }
    let cancelled = false
    let page: PDFPageProxy | null = null
    void (async () => {
      page = await doc.getPage(number)
      if (cancelled) return
      const natural = page.getViewport({ scale: 1 })
      setOwn(o => o && o.width === natural.width && o.height === natural.height ? o : { width: natural.width, height: natural.height })
      const viewport = page.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      // Drawn off screen and then swapped in, so after a zoom the old drawing (stretched) shows until then.
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise
      if (cancelled) return
      const text = document.createElement('div')
      text.className = 'textLayer'
      el.replaceChildren(canvas, text)
      el.style.setProperty('--scale-factor', String(scale))
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render()
      if (!cancelled) markHighlights(el, marksRef.current)
    })().catch(() => undefined)
    return () => { cancelled = true; page?.cleanup() }
  }, [near, doc, number, scale])

  // Saved highlights are drawn on the page's text (and again when one is added).
  const marksRef = useRef(marks)
  marksRef.current = marks
  const markKey = marks.join('\u0000')
  useEffect(() => { if (box.current) markHighlights(box.current, marks) }, [markKey])

  return <div ref={box} className="book-page" data-page={number} style={{ width: shown.width * scale, height: shown.height * scale }} />
}

function markHighlights(page: HTMLElement, quotes: string[]) {
  for (const span of page.querySelectorAll<HTMLElement>('.textLayer span')) span.classList.toggle('bd-highlight', quotes.length > 0 && inHighlight(span.textContent ?? '', quotes))
}

export default function BookTab({ tab, active }: { tab: DynamicTab; active: boolean }) {
  const course = String(tab.params?.course ?? '')
  const file = String(tab.params?.file ?? '')
  const title = String(tab.params?.title ?? file)
  const askedPage = Number(tab.params?.page ?? 0)
  const askedAt = String(tab.params?.at ?? '')
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [size, setSize] = useState({ width: 612, height: 792 })
  const [error, setError] = useState('')
  // 'fit' fits the page to the width of the reading area; a number is a chosen zoom (1.3 shows as 100%).
  const [zoom, setZoom] = useState<'fit' | number>(() => savedZoom())
  const [areaWidth, setAreaWidth] = useState(0)
  const [page, setPage] = useState(1)
  const [outline, setOutline] = useState<OutlineItem[] | null>(null)
  const [showOutline, setShowOutline] = useState(false)
  const [status, setStatus] = useState('')
  const [selection, setSelection] = useState('')
  const [card, setCard] = useState<{ back: string; page: number } | null>(null)
  const [question, setQuestion] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  // Where the reader is (a page and how far down it, at `offset` px from the top of the view), kept so
  // that a zoom or resize brings the same spot back instead of jumping to another page.
  const anchor = useRef<{ page: number; frac: number; offset: number } | null>(null)
  const scale = zoom === 'fit' ? (areaWidth > 0 ? Math.min(4, Math.max(0.3, (areaWidth - 24) / size.width)) : 1.3) : zoom
  const isEpub = file.toLowerCase().endsWith('.epub')
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('bd-pdf-dark') === '1' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('bd-pdf-dark', dark ? '1' : '0') } catch { /* not remembered */ } }, [dark])
  const allNotes = useStore(notesStore)
  const highlightNote = allNotes.find(n => n.title === highlightsTitle(title) && n.folder === courseFolder(course))
  const marks = useMemo(() => highlightsByPage(highlightNote, course, file), [highlightNote, course, file])

  useEffect(() => {
    if (isEpub) return
    let cancelled = false
    let loaded: PDFDocumentProxy | null = null
    void (async () => {
      try {
        loaded = await loadBook(course, file)
        if (cancelled) return void loaded.destroy()
        const first = await loaded.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        setSize({ width: viewport.width, height: viewport.height })
        setDoc(loaded)
        setOutline(await resolveOutline(loaded, await loaded.getOutline() as Outline | null))
      } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    })()
    return () => { cancelled = true; void loaded?.destroy() }
  }, [course, file, isEpub])

  function goTo(n: number) {
    if (!doc) return
    const target = Math.min(Math.max(1, n), doc.numPages)
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${target}"]`)
    if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - 8
    anchor.current = { page: target, frac: 0, offset: 8 }
    setPage(target)
  }

  /** The page at `offset` px from the top of the view, and how far down it that point is. */
  const spotAt = useCallback((offset: number) => {
    const box = scroller.current
    if (!box) return null
    const pages = box.querySelectorAll<HTMLElement>('.book-page')
    const y = box.scrollTop + offset
    let lo = 0, hi = pages.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (pages[mid].offsetTop <= y) lo = mid; else hi = mid - 1
    }
    const el = pages[lo]
    if (!el) return null
    return { page: Number(el.dataset.page), frac: Math.min(1, Math.max(0, (y - el.offsetTop) / Math.max(1, el.offsetHeight))), offset }
  }, [])

  function onScroll() {
    const box = scroller.current
    if (!box) return
    anchor.current = spotAt(box.clientHeight / 3)
    if (anchor.current) setPage(anchor.current.page)
  }

  // After a zoom (or the area resizing in fit mode), put the same spot back where it was.
  useLayoutEffect(() => {
    const box = scroller.current
    const at = anchor.current
    if (!box || !at) return
    const el = box.querySelector<HTMLElement>(`[data-page="${at.page}"]`)
    if (el) box.scrollTop = el.offsetTop + at.frac * el.offsetHeight - at.offset
  }, [scale])

  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const observer = new ResizeObserver(() => setAreaWidth(box.clientWidth))
    observer.observe(box)
    return () => observer.disconnect()
  }, [doc])

  function zoomTo(next: 'fit' | number, offset?: number) {
    const box = scroller.current
    if (box) anchor.current = spotAt(offset ?? box.clientHeight / 3) ?? anchor.current
    const value = next === 'fit' ? next : Math.min(4, Math.max(0.4, +next.toFixed(2)))
    setZoom(value)
    saveZoom(value)
  }

  // Pinch on a trackpad (and Ctrl + scroll wheel) zooms around the pointer.
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const current = zoomRef.current
      zoomTo(current * Math.exp(-e.deltaY / 300), e.clientY - box.getBoundingClientRect().top)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [doc])
  const zoomRef = useRef(scale)
  zoomRef.current = scale

  // Open where it was asked (a highlight's link) or where it was left.
  useEffect(() => {
    if (!doc) return
    const target = askedPage || savedPage(course, file)
    window.setTimeout(() => goTo(target), 50)
  }, [doc, askedPage, askedAt])

  useEffect(() => { if (doc) savePage(course, file, page) }, [doc, page, course, file])

  useEffect(() => {
    const onSelect = () => {
      const sel = window.getSelection()
      setSelection(sel && scroller.current?.contains(sel.anchorNode) ? sel.toString().trim() : '')
    }
    document.addEventListener('selectionchange', onSelect)
    return () => document.removeEventListener('selectionchange', onSelect)
  }, [])

  async function saveHighlight() {
    const text = selection
    if (!text) return
    const folder = courseFolder(course)
    const existing = notesStore.get().find(n => n.title === highlightsTitle(title) && n.folder === folder)
    try {
      if (!existing) {
        const created = await notesCreateMarkdown(highlightsTitle(title), folder, 'note', `> ${text.replace(/\s+/g, ' ')}\n\n[${title}, p. ${page}](${bookLink(course, file, page)})`)
        notesStore.set(list => [created, ...list])
      } else {
        const shown = visible(existing)
        const last = shown[shown.length - 1]?.pos ?? ''
        const quotePos = between(last, '')
        const block = (kind: NoteBlock['kind'], text: string, pos: string): NoteBlock => ({ id: newId(), kind, text, checked: false, due: null, pos, updated: 0, by: '', deleted: false })
        const saved = await notesSave({ id: existing.id, blocks: [block('quote', text.replace(/\s+/g, ' '), quotePos), block('p', `[${title}, p. ${page}](${bookLink(course, file, page)})`, between(quotePos, ''))] })
        notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
      }
      window.getSelection()?.removeAllRanges()
      setStatus(`Saved to “${highlightsTitle(title)}”`)
    } catch (e) { setStatus(String(e)) }
  }

  async function saveCard() {
    if (!card || !question.trim()) return
    try {
      await addCards(course, [cardLine(question, card.back, `[${title}, p. ${card.page}](${bookLink(course, file, card.page)})`)])
      setCard(null)
      setQuestion('')
      setStatus(`Card added to “${course} — flashcards”.`)
    } catch (e) { setStatus(String(e)) }
  }

  async function chapterChecklist() {
    if (!outline?.length) { setStatus('This book has no table of contents to turn into a checklist.'); return }
    const folder = courseFolder(course)
    const existing = notesStore.get().find(n => n.title === chaptersTitle(title) && n.folder === folder)
    if (existing) { openNoteRequest.set(existing.id); activateTab('notes'); return }
    try {
      const note = await notesCreateMarkdown(chaptersTitle(title), folder, 'list', outlineToMarkdown(outline))
      notesStore.set(list => [note, ...list])
      void refreshNotes()
      setStatus(`Made “${chaptersTitle(title)}” in Notes (${folder}).`)
    } catch (e) { setStatus(String(e)) }
  }

  if (isEpub) return <EpubTab tab={tab} active={active} />

  return <div className="book-tab" style={{ display: active ? undefined : 'none' }}>
    <div className="book-toolbar">
      <button className="cal-icon" title="Contents" onClick={() => setShowOutline(v => !v)}><ListTree size={16} /></button>
      <button className="cal-icon" title="Previous page" onClick={() => goTo(page - 1)}><ChevronLeft size={16} /></button>
      <span className="book-page-number"><input value={page} onChange={e => setPage(Number(e.target.value) || page)} onKeyDown={e => { if (e.key === 'Enter') goTo(page) }} /> / {doc?.numPages ?? '…'}</span>
      <button className="cal-icon" title="Next page" onClick={() => goTo(page + 1)}><ChevronRight size={16} /></button>
      <button className="cal-icon" title="Smaller (or pinch)" onClick={() => zoomTo(scale - 0.15)}><Minus size={15} /></button>
      <span className="book-zoom">{Math.round(scale * 100 / 1.3)}%</span>
      <button className="cal-icon" title="Larger (or pinch)" onClick={() => zoomTo(scale + 0.15)}><Plus size={15} /></button>
      <button className={`cal-icon${zoom === 'fit' ? ' on' : ''}`} title="Fit the page to the width" onClick={() => zoomTo('fit')}><MoveHorizontal size={15} /></button>
      <button className={`cal-icon${dark ? ' on' : ''}`} title={dark ? 'Light pages' : 'Dark pages (for reading at night)'} onClick={() => setDark(d => !d)}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
      <span className="grow book-title">{title}</span>
      <button className="ghost" disabled={!selection} title="Select text in the book first" onMouseDown={e => e.preventDefault()} onClick={() => void saveHighlight()}><Highlighter size={14} /> Save highlight</button>
      <button className="ghost" disabled={!selection} title="Make a flashcard with the selected text as the answer" onMouseDown={e => e.preventDefault()} onClick={() => { setCard({ back: selection.replace(/\s+/g, ' '), page }); window.getSelection()?.removeAllRanges() }}><Layers size={14} /> Flashcard</button>
      <button className="ghost" disabled={!selection} title="Open ChatGPT with this passage, ready for you to send" onMouseDown={e => e.preventDefault()} onClick={() => void askChatGPT(passagePrompt(title, page, selection), courseFolder(course)).catch(e => setStatus(String(e)))}><MessageCircleQuestion size={14} /> Ask ChatGPT</button>
      <button className="ghost" onClick={() => void chapterChecklist()}><ListChecks size={14} /> Chapter checklist</button>
    </div>
    {card && <form className="book-card-form" onSubmit={e => { e.preventDefault(); void saveCard() }}>
      <input autoFocus placeholder="Question for this card" value={question} onChange={e => setQuestion(e.target.value)} />
      <span title={card.back}>Answer: {card.back}</span>
      <button className="ghost" disabled={!question.trim()}>Add card</button>
      <button type="button" className="ghost" onClick={() => setCard(null)}>Cancel</button>
    </form>}
    {status && <p className="book-status">{status}</p>}
    <div className="book-body">
      {showOutline && <nav className="book-outline">{outline?.length ? <Contents items={outline} page={page} onGo={goTo} /> : <p className="hint">No table of contents in this book.</p>}</nav>}
      <div className={`book-scroll${dark ? ' dark' : ''}`} ref={scroller} onScroll={onScroll}>
        {error ? <p className="cal-error">{error}</p> : !doc ? <p className="hint">Opening…</p>
          : Array.from({ length: doc.numPages }, (_, i) => <Page key={i} doc={doc} number={i + 1} scale={scale} size={size} marks={marks.get(i + 1) ?? NO_MARKS} />)}
      </div>
    </div>
  </div>
}

/** The book's contents, chapters folded: a chapter's sections show when it's opened. The chapter
 *  being read is marked, and opened when the contents are shown. */
function Contents({ items, page, onGo }: { items: OutlineItem[]; page: number; onGo: (page: number) => void }) {
  const current = useMemo(() => currentPath(items, page), [items, page])
  const [open, setOpen] = useState<Set<string>>(() => new Set(current.slice(0, -1)))
  const all = useMemo(() => outlineParents(items), [items])
  const toggle = (path: string) => setOpen(o => { const n = new Set(o); if (n.has(path)) n.delete(path); else n.add(path); return n })
  return <>
    <div className="book-outline-head">
      <button onClick={() => setOpen(new Set())}>Collapse all</button>
      <button onClick={() => setOpen(new Set(all))}>Expand all</button>
    </div>
    <OutlineList items={items} path="" open={open} current={current[current.length - 1] ?? ''} onToggle={toggle} onGo={onGo} />
  </>
}

function OutlineList({ items, path, open, current, onToggle, onGo }: { items: OutlineItem[]; path: string; open: Set<string>; current: string; onToggle: (path: string) => void; onGo: (page: number) => void }) {
  return <ul>{items.map((item, i) => {
    const here = `${path}${i}/`
    const folded = item.items.length > 0 && !open.has(here)
    return <li key={i}>
      <div className="book-outline-row">
        <button className={`book-outline-toggle${item.items.length ? '' : ' empty'}`} title={folded ? 'Show sections' : 'Hide sections'} onClick={() => onToggle(here)}>
          {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
        <button className={here === current ? 'current' : undefined} disabled={!item.page} onClick={() => item.page && onGo(item.page)}>{item.title}{item.page ? <small>{item.page}</small> : null}</button>
      </div>
      {item.items.length > 0 && !folded && <OutlineList items={item.items} path={here} open={open} current={current} onToggle={onToggle} onGo={onGo} />}
    </li>
  })}</ul>
}

const ZOOM_KEY = 'bd-book-zoom'
function savedZoom(): 'fit' | number {
  try { const v = localStorage.getItem(ZOOM_KEY); return !v || v === 'fit' ? 'fit' : Number(v) || 'fit' } catch { return 'fit' }
}
function saveZoom(zoom: 'fit' | number) {
  try { localStorage.setItem(ZOOM_KEY, String(zoom)) } catch { /* not remembered */ }
}
