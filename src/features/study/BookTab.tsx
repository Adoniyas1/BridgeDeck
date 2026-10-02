import { useEffect, useRef, useState } from 'react'
import { BookMarked, ChevronLeft, ChevronRight, Highlighter, Layers, MessageCircleQuestion, ListChecks, ListTree, Minus, Plus } from 'lucide-react'
import 'pdfjs-dist/web/pdf_viewer.css'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { notesCreateMarkdown, notesSave, openPath, type NoteBlock } from '../../lib/bridge'
import type { DynamicTab } from '../../core/tabs'
import { activateTab } from '../../core/tabs'
import { between, newId, visible } from '../notes/model'
import { notesStore, openNoteRequest, refreshNotes } from '../notes/state'
import { bookLink, chaptersTitle, courseFolder, highlightsTitle, outlineToMarkdown, type OutlineItem } from './model'
import { addCards, libraryStore } from './state'
import { cardLine } from './cards'
import { askChatGPT, passagePrompt } from '../../core/chatgpt'
import { loadBook, pdfjs } from './pdf'

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
function Page({ doc, number, scale, size, onVisible }: { doc: PDFDocumentProxy; number: number; scale: number; size: { width: number; height: number }; onVisible: (n: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        setNear(entry.isIntersecting)
        if (entry.intersectionRatio > 0.5) onVisible(number)
      }
    }, { rootMargin: '600px 0px', threshold: [0, 0.5] })
    observer.observe(el)
    return () => observer.disconnect()
  }, [number, onVisible])

  useEffect(() => {
    const el = box.current
    if (!near || !el) return
    let cancelled = false
    let page: PDFPageProxy | null = null
    void (async () => {
      page = await doc.getPage(number)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const text = document.createElement('div')
      text.className = 'textLayer'
      el.replaceChildren(canvas, text)
      el.style.setProperty('--scale-factor', String(scale))
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise
      if (cancelled) return
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render()
    })().catch(() => undefined)
    return () => { cancelled = true; page?.cleanup(); el.replaceChildren() }
  }, [near, doc, number, scale])

  return <div ref={box} className="book-page" data-page={number} style={{ width: size.width * scale, height: size.height * scale }} />
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
  const [scale, setScale] = useState(1.3)
  const [page, setPage] = useState(1)
  const [outline, setOutline] = useState<OutlineItem[] | null>(null)
  const [showOutline, setShowOutline] = useState(false)
  const [status, setStatus] = useState('')
  const [selection, setSelection] = useState('')
  const [card, setCard] = useState<{ back: string; page: number } | null>(null)
  const [question, setQuestion] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const isEpub = file.toLowerCase().endsWith('.epub')

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
    scroller.current?.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ block: 'start' })
    setPage(target)
  }

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

  if (isEpub) {
    const root = libraryStore.get().library?.root ?? ''
    return <div className="book-tab"><div className="card book-message"><BookMarked size={22} /><p>EPUB books open in your usual reader for now; reading them inside BridgeDeck comes next.</p>
      <div className="actions"><button onClick={() => void openPath(`${root}/${course}/${file}`)}><BookMarked size={15} />Open in your reader</button></div></div></div>
  }

  return <div className="book-tab" style={{ display: active ? undefined : 'none' }}>
    <div className="book-toolbar">
      <button className="cal-icon" title="Contents" onClick={() => setShowOutline(v => !v)}><ListTree size={16} /></button>
      <button className="cal-icon" title="Previous page" onClick={() => goTo(page - 1)}><ChevronLeft size={16} /></button>
      <span className="book-page-number"><input value={page} onChange={e => setPage(Number(e.target.value) || page)} onKeyDown={e => { if (e.key === 'Enter') goTo(page) }} /> / {doc?.numPages ?? '…'}</span>
      <button className="cal-icon" title="Next page" onClick={() => goTo(page + 1)}><ChevronRight size={16} /></button>
      <button className="cal-icon" title="Smaller" onClick={() => setScale(s => Math.max(0.6, +(s - 0.15).toFixed(2)))}><Minus size={15} /></button>
      <span className="book-zoom">{Math.round(scale * 100 / 1.3)}%</span>
      <button className="cal-icon" title="Larger" onClick={() => setScale(s => Math.min(3, +(s + 0.15).toFixed(2)))}><Plus size={15} /></button>
      <span className="grow book-title">{title}</span>
      <button className="ghost" disabled={!selection} title="Select text in the book first" onMouseDown={e => e.preventDefault()} onClick={() => void saveHighlight()}><Highlighter size={14} /> Save highlight</button>
      <button className="ghost" disabled={!selection} title="Make a flashcard with the selected text as the answer" onMouseDown={e => e.preventDefault()} onClick={() => { setCard({ back: selection.replace(/\s+/g, ' '), page }); window.getSelection()?.removeAllRanges() }}><Layers size={14} /> Flashcard</button>
      <button className="ghost" disabled={!selection} title="Open ChatGPT with this passage, ready for you to send" onMouseDown={e => e.preventDefault()} onClick={() => void askChatGPT(passagePrompt(title, page, selection)).catch(e => setStatus(String(e)))}><MessageCircleQuestion size={14} /> Ask ChatGPT</button>
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
      {showOutline && <nav className="book-outline">{outline?.length ? <OutlineList items={outline} onGo={goTo} /> : <p className="hint">No table of contents in this book.</p>}</nav>}
      <div className="book-scroll" ref={scroller}>
        {error ? <p className="cal-error">{error}</p> : !doc ? <p className="hint">Opening…</p>
          : Array.from({ length: doc.numPages }, (_, i) => <Page key={`${i}-${scale}`} doc={doc} number={i + 1} scale={scale} size={size} onVisible={setPage} />)}
      </div>
    </div>
  </div>
}

function OutlineList({ items, onGo }: { items: OutlineItem[]; onGo: (page: number) => void }) {
  return <ul>{items.map((item, i) => <li key={i}>
    <button disabled={!item.page} onClick={() => item.page && onGo(item.page)}>{item.title}{item.page ? <small>{item.page}</small> : null}</button>
    {item.items.length > 0 && <OutlineList items={item.items} onGo={onGo} />}
  </li>)}</ul>
}
