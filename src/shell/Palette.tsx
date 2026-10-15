import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Keyboard, Search } from 'lucide-react'
import { circuitsList, codeFiles, isTauri, notesCreate, studySearch, type CircuitFile, type CodeFile, type StudyHit } from '../lib/bridge'
import { openCircuitRequest, openCodeRequest } from '../core/openRequests'
import { useAssignments } from '../features/study/assignments'
import { askChatGPT } from '../core/chatgpt'
import { configStore } from '../core/config'
import { CTRL_SHORTCUTS, MOD, openInBrowser, paletteStore, runShortcut, shortcutFor, shortcutsHelpStore, SHORTCUTS, type ShortcutName } from '../core/shortcuts'
import { useStore } from '../core/store'
import { activateTab, tabsStore } from '../core/tabs'
import { features } from '../features/registry'
import { notesStore, openNoteRequest } from '../features/notes/state'
import { noteTitle, preview, matches } from '../features/notes/model'
import { eventsStore } from '../features/calendar/state'
import { historyStore } from '../features/browser/state'
import { openBook } from '../features/study/open'
import { best, looksLikeUrl, type Hit } from './search'

/** BridgeDeck's keyboard shortcuts: from the window, and from web pages (src-tauri/src/webkeys.rs). */
export function ShortcutKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const name = shortcutFor(e)
      if (name) { if (runShortcut(name)) e.preventDefault(); return }
      // ⌘1–9 (Ctrl on Windows): the nth tab.
      const mod = /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const order = [...features.filter(f => f.Page).map(f => f.id), ...tabsStore.get().dynamic.map(t => t.id)]
        const id = order[Number(e.key) - 1]
        if (id) { e.preventDefault(); activateTab(id) }
      }
    }
    window.addEventListener('keydown', onKey)
    let stop: (() => void) | undefined
    let closed = false
    if (isTauri()) void listen<{ key: ShortcutName; text: string; url: string | null }>('web-key', e => runShortcut(e.payload.key, { text: e.payload.text, url: e.payload.url }))
      .then(fn => { if (closed) fn(); else stop = fn })
    return () => { closed = true; window.removeEventListener('keydown', onKey); stop?.() }
  }, [])
  return null
}

/** Search everything (⌘K): tabs, actions, notes, calendar, bookmarks, history and the books' text. */
export function Palette() {
  const open = useStore(paletteStore)
  if (!open) return null
  return <PaletteBox />
}

function PaletteBox() {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(0)
  const [books, setBooks] = useState<StudyHit[]>([])
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const close = () => paletteStore.set(false)
  const notes = useStore(notesStore)
  const events = useStore(eventsStore)
  const history = useStore(historyStore)
  const dynamic = useStore(tabsStore).dynamic
  const assignments = useAssignments()
  const [saved, setSaved] = useState<{ circuits: CircuitFile[]; code: CodeFile[] }>({ circuits: [], code: [] })

  useEffect(() => { input.current?.focus() }, [])
  // Saved circuits and programs, listed once when search opens.
  useEffect(() => {
    if (!isTauri()) return
    void Promise.all([circuitsList().catch(() => []), codeFiles().catch(() => [])]).then(([circuits, code]) => setSaved({ circuits, code }))
  }, [])

  // The books' text is searched natively, a moment after typing stops.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3 || !isTauri()) { setBooks([]); return }
    const timer = window.setTimeout(() => void studySearch(q).then(hits => setBooks(hits.slice(0, 5))).catch(() => setBooks([])), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const hits = useMemo(() => {
    const q = query.trim()
    const go = (run: () => void) => () => { close(); run() }
    const out: Hit[] = []
    if (q && looksLikeUrl(q)) out.push({ id: 'url', group: 'Web', title: `Open ${q}`, detail: 'In the Browser tab', run: go(() => openInBrowser(q)) })
    const tabs: Array<{ id: string; title: string }> = [...features.filter(f => f.Page).map(f => ({ id: f.id, title: f.title })), { id: 'settings', title: 'Settings' }, ...dynamic.map(t => ({ id: t.id, title: t.title }))]
    out.push(...best(tabs, q, t => [t.title], q ? 4 : 20).map(t => ({ id: `tab:${t.id}`, group: 'Tabs', title: t.title, run: go(() => activateTab(t.id)) })))
    const actions: Hit[] = [
      { id: 'new-note', group: 'Actions', title: 'New note', run: go(() => void notesCreate('note', '').then(n => { openNoteRequest.set(n.id); activateTab('notes') }).catch(() => activateTab('notes'))) },
      { id: 'ask', group: 'Actions', title: q && !looksLikeUrl(q) ? `Ask ChatGPT: ${q}` : 'Ask ChatGPT', run: go(() => void askChatGPT(q && !looksLikeUrl(q) ? q : undefined)) },
      { id: 'shortcuts', group: 'Actions', title: 'Keyboard shortcuts', detail: `${MOD} /`, run: go(() => shortcutsHelpStore.set(true)) },
    ]
    // With nothing typed the actions come right after the tabs; with a search, after what it found.
    if (!q) out.push(...actions)
    if (q) {
      out.push(...best(notes.filter(n => !n.deleted && matches(n, q)), q, n => [noteTitle(n), `${n.folder} ${preview(n)}`], 6)
        .map(n => ({ id: `note:${n.id}`, group: 'Notes', title: noteTitle(n) || 'Untitled', detail: [n.folder, preview(n)].filter(Boolean).join(' · '), run: go(() => { openNoteRequest.set(n.id); activateTab('notes') }) })))
      out.push(...best(events.filter(e => !e.deleted), q, e => [e.title, e.location], 4)
        .map(e => ({ id: `event:${e.id}`, group: 'Calendar', title: e.title, detail: new Date(e.start).toLocaleString(undefined, { dateStyle: 'medium', ...(e.allDay ? {} : { timeStyle: 'short' }) }), run: go(() => activateTab('calendar')) })))
      out.push(...best(saved.circuits, q, c => [c.name, c.project], 4)
        .map(c => ({ id: `circuit:${c.project}/${c.name}`, group: 'Circuits', title: c.name, detail: c.project || 'Logic', run: go(() => { openCircuitRequest.set(c); activateTab('logic') }) })))
      out.push(...best(saved.code, q, c => [c.name, c.language], 4)
        .map(c => ({ id: `code:${c.language}/${c.name}`, group: 'Code', title: c.name, detail: c.language, run: go(() => { openCodeRequest.set(c); activateTab('code') }) })))
      out.push(...best(assignments.filter(a => !a.done), q, a => [a.title, a.course], 4)
        .map(a => ({ id: `assignment:${a.id}`, group: 'Assignments', title: a.title, detail: [a.course, a.due ? `due ${new Date(a.due).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''].filter(Boolean).join(' · '), run: go(() => activateTab('study')) })))
      out.push(...books.map((b, i) => ({ id: `book:${i}:${b.file}:${b.page}`, group: 'Books', title: `${b.book}, p. ${b.page}`, detail: b.snippet, run: go(() => openBook(b.course, b.file, b.book, b.page)) })))
      const pages = [...configStore.get().browsing.bookmarks.map(b => ({ url: b.url, title: b.name, mark: true })), ...history.map(h => ({ url: h.url, title: h.title, mark: false }))]
      const seen = new Set<string>()
      out.push(...best(pages.filter(p => !seen.has(p.url) && seen.add(p.url)), q, p => [p.title || p.url, p.url], 5)
        .map(p => ({ id: `web:${p.url}`, group: p.mark ? 'Bookmarks' : 'History', title: p.title || p.url, detail: p.url, run: go(() => openInBrowser(p.url)) })))
      out.push(...actions.filter(a => a.id === 'ask' || best([a], q, x => [x.title], 1).length))
      if (!looksLikeUrl(q)) out.push({ id: 'web-search', group: 'Web', title: `Search the web for “${q}”`, run: go(() => openInBrowser(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`)) })
    }
    return out
  }, [query, notes, events, history, dynamic, books])

  useEffect(() => { setPicked(0) }, [query])
  useEffect(() => { list.current?.querySelector('.palette-hit.on')?.scrollIntoView({ block: 'nearest' }) }, [picked])

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setPicked(p => Math.min(p + 1, hits.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPicked(p => Math.max(p - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); hits[picked]?.run() }
  }

  let group = ''
  return <div className="palette-back" onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div className="palette" role="dialog" aria-label="Search everything" onKeyDown={onKey}>
      <div className="palette-input"><Search size={16} /><input ref={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tabs, notes, books, calendar, bookmarks… or type a web address" spellCheck={false} /><kbd>esc</kbd></div>
      <div ref={list} className="palette-list">
        {hits.map((hit, i) => {
          const head = hit.group !== group ? (group = hit.group) : null
          return <div key={hit.id}>
            {head && <div className="palette-group">{head}</div>}
            <button className={`palette-hit${i === picked ? ' on' : ''}`} onMouseMove={() => setPicked(i)} onClick={hit.run}>
              <span>{hit.title}</span>{hit.detail && <small>{hit.detail}</small>}
            </button>
          </div>
        })}
        {!hits.length && <p className="hint palette-empty">Nothing found.</p>}
      </div>
    </div>
  </div>
}

/** The list of keyboard shortcuts (⌘/). */
export function ShortcutsHelp() {
  const open = useStore(shortcutsHelpStore)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') shortcutsHelpStore.set(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (!open) return null
  return <div className="palette-back" onMouseDown={e => { if (e.target === e.currentTarget) shortcutsHelpStore.set(false) }}>
    <div className="palette shortcuts-help" role="dialog" aria-label="Keyboard shortcuts">
      <header><Keyboard size={16} /><strong>Keyboard shortcuts</strong><span className="grow" /><button className="ghost" onClick={() => shortcutsHelpStore.set(false)}>Close</button></header>
      <table><tbody>
        {SHORTCUTS.map(s => <tr key={s.keys}><td><kbd>{MOD}</kbd> {s.keys.split(' ').map(k => <kbd key={k}>{k}</kbd>)}</td><td>{s.what}</td></tr>)}
        {CTRL_SHORTCUTS.map(s => <tr key={s.keys}><td>{s.keys.split(' ').map(k => <kbd key={k}>{k}</kbd>)}</td><td>{s.what}</td></tr>)}
      </tbody></table>
      <p className="hint">These work on web pages too (Browser, TV, the ChatGPT panel).</p>
    </div>
  </div>
}
