import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronLeft, ChevronRight, Highlighter, Layers, ListTree, MessageCircleQuestion, Minus, Moon, Plus, Sun } from 'lucide-react'
import ePub, { type Book, type NavItem, type Rendition } from 'epubjs'
import { notesCreateMarkdown, notesSave, type NoteBlock } from '../../lib/bridge'
import type { DynamicTab } from '../../core/tabs'
import { askChatGPT, passagePrompt } from '../../core/chatgpt'
import { useTabContext } from '../../core/tabContext'
import { askMimir } from '../mimir'
import { mimirPassagePrompt, readingContext } from './model'
import { between, newId, visible } from '../notes/model'
import { notesStore } from '../notes/state'
import { cardLine } from './cards'
import { bookLink, courseFolder, highlightsTitle } from './model'
import { flushPlaces, placeOf, rememberPlace } from './reading'
import { addCards } from './state'
import { loadBookBytes } from './pdf'

const placeKey = (course: string, file: string) => `bd-epub-place:${course}/${file}`
const SIZE_KEY = 'bd-epub-size'
const DARK_KEY = 'bd-epub-dark'
const read = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* not remembered */ } }

/** An EPUB book inside BridgeDeck (epub.js): pages, contents, text size, dark pages, and the same
 *  highlight, flashcard and ChatGPT tools as PDFs. Its place is remembered. */
export default function EpubTab({ tab, active }: { tab: DynamicTab; active: boolean }) {
  const course = String(tab.params?.course ?? '')
  const file = String(tab.params?.file ?? '')
  const title = String(tab.params?.title ?? file)
  const askedChapter = Number(tab.params?.page ?? 0)
  const askedAt = String(tab.params?.at ?? '')
  const area = useRef<HTMLDivElement>(null)
  const book = useRef<Book | null>(null)
  const rendition = useRef<Rendition | null>(null)
  const [toc, setToc] = useState<NavItem[]>([])
  const [showToc, setShowToc] = useState(false)
  const [chapter, setChapter] = useState('')
  const [percent, setPercent] = useState<number | null>(null)
  const [size, setSize] = useState(() => Number(read(SIZE_KEY)) || 100)
  const [dark, setDark] = useState(() => read(DARK_KEY) !== '0')
  const [selection, setSelection] = useState('')
  const [card, setCard] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  useTabContext(tab.id, () => ({ title: chapter ? `${title}: ${chapter}` : title, text: readingContext({ course, title, where: [chapter && `chapter “${chapter}”`, percent != null && `${percent}% through`].filter(Boolean).join(', ') || 'open', selection, text: '' }) }))

  useEffect(() => {
    const el = area.current
    if (!el) return
    let cancelled = false
    void (async () => {
      try {
        const opened = ePub(await loadBookBytes(course, file))
        if (cancelled) return
        book.current = opened
        const view = opened.renderTo(el, { width: '100%', height: '100%', flow: 'paginated', spread: 'none', allowScriptedContent: false })
        rendition.current = view
        view.themes.register('bd-dark', { body: { color: '#e4e6eb !important', background: '#17181b !important' }, a: { color: '#8ab4ff !important' } })
        view.themes.register('bd-light', { body: { color: '#111 !important', background: '#fff !important' } })
        view.on('relocated', (where: { start: { cfi: string; href: string; percentage?: number } }) => {
          write(placeKey(course, file), where.start.cfi)
          rememberPlace(course, file, { cfi: where.start.cfi })
          if (typeof where.start.percentage === 'number' && opened.locations.length()) setPercent(Math.round(where.start.percentage * 100))
          const item = opened.navigation?.get(where.start.href)
          setChapter(item?.label?.trim() ?? '')
        })
        view.on('selected', (_cfi: string, contents: { window: Window }) => setSelection(contents.window.getSelection()?.toString().trim() ?? ''))
        view.on('keyup', (e: KeyboardEvent) => { if (e.key === 'ArrowRight') void view.next(); if (e.key === 'ArrowLeft') void view.prev() })
        await opened.ready
        setToc(opened.navigation.toc)
        const left = askedChapter > 0 ? null : await placeOf(course, file, { cfi: read(placeKey(course, file)) ?? undefined })
        if (cancelled) return
        const start = askedChapter > 0 ? opened.spine.get(askedChapter - 1)?.href : left?.cfi || undefined
        await view.display(start)
        // Positions through the book, for "x% read" (in the background; large books take a moment).
        void opened.locations.generate(1600).then(() => { if (!cancelled) setPercent(p => p ?? 0) })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true; flushPlaces(); rendition.current?.destroy(); book.current?.destroy(); rendition.current = null; book.current = null }
  }, [course, file, askedChapter, askedAt])

  useEffect(() => {
    const view = rendition.current
    if (!view) return
    view.themes.select(dark ? 'bd-dark' : 'bd-light')
    view.themes.fontSize(`${size}%`)
    write(SIZE_KEY, String(size)); write(DARK_KEY, dark ? '1' : '0')
  }, [size, dark, toc])

  // Fit the pages to the reading area when it changes size (contents shown or hidden, window resized).
  useEffect(() => {
    const el = area.current
    if (!el) return
    const observer = new ResizeObserver(() => { const view = rendition.current; if (view && el.clientWidth > 0) view.resize(el.clientWidth, el.clientHeight) })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowRight') void rendition.current?.next()
      if (e.key === 'ArrowLeft') void rendition.current?.prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  async function saveHighlight() {
    const text = selection.replace(/\s+/g, ' ')
    if (!text) return
    const folder = courseFolder(course)
    const where = chapter ? `${title}, ${chapter}` : title
    const existing = notesStore.get().find(n => n.title === highlightsTitle(title) && n.folder === folder)
    try {
      if (!existing) {
        const created = await notesCreateMarkdown(highlightsTitle(title), folder, 'note', `> ${text}\n\n[${where}](${bookLink(course, file, 1)})`)
        notesStore.set(list => [created, ...list])
      } else {
        const last = visible(existing).at(-1)?.pos ?? ''
        const quotePos = between(last, '')
        const block = (kind: NoteBlock['kind'], body: string, pos: string): NoteBlock => ({ id: newId(), kind, text: body, checked: false, due: null, pos, updated: 0, by: '', deleted: false })
        const saved = await notesSave({ id: existing.id, blocks: [block('quote', text, quotePos), block('p', `[${where}](${bookLink(course, file, 1)})`, between(quotePos, ''))] })
        notesStore.set(list => list.map(n => n.id === saved.id ? saved : n))
      }
      setStatus(`Saved to “${highlightsTitle(title)}”`)
    } catch (e) { setStatus(String(e)) }
  }

  async function saveCard() {
    if (!card || !question.trim()) return
    try {
      await addCards(course, [cardLine(question, card, `[${chapter ? `${title}, ${chapter}` : title}](${bookLink(course, file, 1)})`)])
      setCard(null); setQuestion('')
      setStatus(`Card added to “${course} — flashcards”.`)
    } catch (e) { setStatus(String(e)) }
  }

  return <div className="book-tab epub-tab" style={{ display: active ? undefined : 'none' }}>
    <div className="book-toolbar">
      <button className="cal-icon" title="Contents" onClick={() => setShowToc(v => !v)}><ListTree size={16} /></button>
      <button className="cal-icon" title="Previous page (←)" onClick={() => void rendition.current?.prev()}><ChevronLeft size={16} /></button>
      <button className="cal-icon" title="Next page (→)" onClick={() => void rendition.current?.next()}><ChevronRight size={16} /></button>
      <button className="cal-icon" title="Smaller text" onClick={() => setSize(s => Math.max(70, s - 10))}><Minus size={15} /></button>
      <span className="book-zoom">{size}%</span>
      <button className="cal-icon" title="Larger text" onClick={() => setSize(s => Math.min(200, s + 10))}><Plus size={15} /></button>
      <button className="cal-icon" title={dark ? 'Light pages' : 'Dark pages'} onClick={() => setDark(d => !d)}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
      <span className="grow book-title">{title}{chapter ? ` · ${chapter}` : ''}{percent !== null ? ` · ${percent}%` : ''}</span>
      <button className="ghost" disabled={!selection} title="Select text in the book first" onClick={() => void saveHighlight()}><Highlighter size={14} /> Save highlight</button>
      <button className="ghost" disabled={!selection} title="Make a flashcard with the selected text as the answer" onClick={() => setCard(selection.replace(/\s+/g, ' '))}><Layers size={14} /> Flashcard</button>
      <button className="ghost" disabled={!selection} title="Ask Mimir to explain this passage (opens beside the book)" onClick={() => void askMimir(mimirPassagePrompt(title, 0, selection, chapter), true)}><Brain size={14} /> Ask Mimir</button>
      <button className="ghost" disabled={!selection} title="Open ChatGPT with this passage, ready for you to send" onClick={() => void askChatGPT(passagePrompt(title, 0, selection).replace(' from page 0', chapter ? ` from “${chapter}”` : ''), courseFolder(course))}><MessageCircleQuestion size={14} /> Ask ChatGPT</button>
    </div>
    {card && <form className="book-card-form" onSubmit={e => { e.preventDefault(); void saveCard() }}>
      <input autoFocus placeholder="Question for this card" value={question} onChange={e => setQuestion(e.target.value)} />
      <span title={card}>Answer: {card}</span>
      <button className="ghost" disabled={!question.trim()}>Add card</button>
      <button type="button" className="ghost" onClick={() => setCard(null)}>Cancel</button>
    </form>}
    {status && <p className="book-status">{status}</p>}
    {error && <p className="cal-error">{error}</p>}
    <div className="book-body">
      {showToc && <nav className="book-outline"><TocList items={toc} onGo={href => void rendition.current?.display(href)} /></nav>}
      <div className={`epub-area${dark ? ' dark' : ''}`} ref={area} />
    </div>
  </div>
}

function TocList({ items, onGo }: { items: NavItem[]; onGo: (href: string) => void }) {
  if (!items.length) return <p className="hint">No table of contents in this book.</p>
  return <ul>{items.map(item => <li key={item.id || item.href}>
    <button onClick={() => onGo(item.href)}>{item.label.trim()}</button>
    {item.subitems && item.subitems.length > 0 && <TocList items={item.subitems} onGo={onGo} />}
  </li>)}</ul>
}
