import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowRight, Clock, Download as DownloadIcon, ExternalLink, FolderOpen, Globe, Laptop, MessageCircleQuestion, PanelTopOpen, Plus, RotateCw, Send, Star, Trash2, X } from 'lucide-react'
import { browserClose, browserGo, browserHide, browserShow, isTauri, openExternal, openPath } from '../../lib/bridge'
import { openTab } from '../../core/tabs'
import { askChatGPT } from '../../core/chatgpt'
import { setConfig, useConfig } from '../../core/config'
import { browserCommandStore, useOverlayOpen } from '../../core/shortcuts'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { queueForSending } from '../files/state'
import { pageName, siteOf } from './model'
import PopupBar from './PopupBar'
import { blockerChangedStore, clearHistory, dismissDownload, downloadsStore, fileName, folderOf, historyStore, markSentOpened, remember, sendPage, useSentPages } from './state'
import { AdShield } from './WebSettings'

const START = [
  { name: 'Search', url: 'https://duckduckgo.com/' },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/' },
  { name: 'Google Scholar', url: 'https://scholar.google.com/' },
  { name: 'Khan Academy', url: 'https://www.khanacademy.org/' },
  { name: 'Wolfram Alpha', url: 'https://www.wolframalpha.com/' },
  { name: 'YouTube', url: 'https://www.youtube.com/' },
]
const MAX_TABS = 12

/** One browser tab: its own native page (src-tauri/src/browser.rs), made on first use. */
type Tab = { id: string; url: string; title: string; loading: boolean; started: boolean }
let nextTab = 1
const blankTab = (): Tab => ({ id: String(nextTab++), url: '', title: '', loading: false, started: false })

/** Websites inside BridgeDeck: each tab's page is a native web view laid over the area below the
 *  address bar, shown only while its tab is picked and the Browser is on screen. */
export default function BrowserPage({ active: onScreen }: { active: boolean }) {
  const config = useConfig()
  // Search everything and the shortcuts list sit where the page would: it's hidden while they're open.
  const overlay = useOverlayOpen()
  const active = onScreen && !overlay
  // The blocker changed: showing the page again remakes it with the new rules (browser.rs).
  const blockerChanged = useStore(blockerChangedStore)
  const address = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const [tabs, setTabs] = useState<Tab[]>(() => [blankTab()])
  const [current, setCurrent] = useState(tabs[0].id)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef<Record<string, string>>({})
  const tab = tabs.find(t => t.id === current) ?? tabs[0]
  const update = (id: string, change: Partial<Tab>) => setTabs(list => list.map(t => t.id === id ? { ...t, ...change } : t))

  // Keep the picked tab's page over the area: on show, resize and layout changes.
  useEffect(() => {
    if (!isTauri() || !tab.started) return
    const id = tab.id
    const el = area.current
    if (!active || !el) { void browserHide(id).catch(() => undefined); return }
    let last = ''
    const place = () => {
      const r = el.getBoundingClientRect()
      const go = pending.current[id] ?? null
      const at = [r.left, r.top, r.width, r.height].map(Math.round).join(',')
      if (at === last && !go) return
      last = at
      delete pending.current[id]
      void browserShow(id, go, r.left, r.top, r.width, r.height).then(() => setError('')).catch(e => setError(String(e)))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    // The area can also move without resizing (a notice above it appears or goes): check now and then.
    const timer = window.setInterval(place, 400)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.clearInterval(timer); void browserHide(id).catch(() => undefined) }
  }, [active, tab.id, tab.started, blockerChanged])

  // The address bar follows the picked tab.
  useEffect(() => { setTyped(tab.url) }, [tab.id])

  const currentRef = useRef(current)
  currentRef.current = current
  useEffect(() => {
    const titles: Record<string, string> = {}
    const stops = [
      listen<{ tab: string; url: string; loading: boolean }>('browser-page', e => {
        const { tab: id, url, loading } = e.payload
        setTabs(list => list.map(t => t.id === id ? { ...t, url, loading } : t))
        if (id === currentRef.current) setTyped(url)
        if (!loading) remember({ url, title: titles[id] ?? '', at: Date.now() })
      }),
      listen<{ tab: string; title: string }>('browser-title', e => {
        const { tab: id, title } = e.payload
        titles[id] = title
        setTabs(list => list.map(t => {
          if (t.id !== id) return t
          if (t.url && title) remember({ url: t.url, title, at: Date.now() })
          return { ...t, title }
        }))
      }),
    ]
    return () => stops.forEach(p => void p.then(stop => stop()).catch(() => undefined))
  }, [])

  function open(where: string, id = tab.id) {
    if (!where.trim()) return
    const target = tabs.find(t => t.id === id)
    if (!target?.started || id !== current) {
      pending.current[id] = where
      update(id, { started: true, url: where })
      setCurrent(id)
      return
    }
    const el = area.current
    if (!el) return
    const r = el.getBoundingClientRect()
    void browserShow(id, where, r.left, r.top, r.width, r.height).catch(e => setError(String(e)))
  }

  function newTab(where?: string) {
    if (tabs.length >= MAX_TABS) { setNotice(`Up to ${MAX_TABS} tabs. Close one first.`); return }
    const t = blankTab()
    setTabs(list => [...list, where ? { ...t, started: true, url: where } : t])
    if (where) pending.current[t.id] = where
    setCurrent(t.id)
    setTyped(where ?? '')
  }

  function closeTab(id: string) {
    if (isTauri()) void browserClose(id).catch(() => undefined)
    delete pending.current[id]
    const index = tabs.findIndex(t => t.id === id)
    const rest = tabs.filter(t => t.id !== id)
    const left = rest.length ? rest : [blankTab()]
    setTabs(left)
    if (id === current) setCurrent(left[Math.min(index, left.length - 1)].id)
  }

  /** Moves a tab's page into a BridgeDeck tab of its own (like a book or PDF): the same page, so it
   *  keeps its place, sign-in and playback. */
  function moveOut(id: string) {
    const t = tabs.find(x => x.id === id)
    if (!t?.started) return
    if (isTauri()) void browserHide(id).catch(() => undefined)
    delete pending.current[id]
    const index = tabs.findIndex(x => x.id === id)
    const rest = tabs.filter(x => x.id !== id)
    const left = rest.length ? rest : [blankTab()]
    setTabs(left)
    if (id === current) setCurrent(left[Math.min(index, left.length - 1)].id)
    openTab({ kind: 'web', title: pageName(t).slice(0, 40), params: { page: t.id, url: t.url, title: t.title } })
  }

  // Shortcuts (⌘T, ⌘W, ⌘L) and pages opened from elsewhere (Search everything).
  const command = useStore(browserCommandStore)
  const handled = useRef(0)
  useEffect(() => {
    if (!command || command.at === handled.current) return
    handled.current = command.at
    if (command.name === 'new-tab') { newTab(); window.setTimeout(() => address.current?.focus(), 0) }
    else if (command.name === 'close-tab') closeTab(tab.id)
    else if (command.name === 'address') address.current?.focus()
    else if (command.name === 'adopt' && command.page) {
      // A page back from its own tab: it already exists, so it's shown as it is.
      const back: Tab = { id: command.page, url: command.url ?? '', title: command.title ?? '', loading: false, started: true }
      // Blank tabs give way to it.
      setTabs(list => [...list.filter(t => t.started && t.id !== back.id), back])
      setCurrent(back.id)
      setTyped(back.url)
    }
    else if (command.name === 'open' && command.url) {
      if (tab.started) newTab(command.url)
      else { setTyped(command.url); open(command.url) }
    }
  }, [command])

  const bookmarks = config.browsing.bookmarks
  const isWeb = /^https?:/.test(tab.url)
  const marked = isWeb && bookmarks.some(b => b.url === tab.url)
  function toggleBookmark() {
    if (!isWeb) return
    const page = { url: tab.url, name: pageName(tab).slice(0, 80) }
    setConfig(c => ({ ...c, browsing: { ...c.browsing, bookmarks: marked ? c.browsing.bookmarks.filter(b => b.url !== page.url) : [...c.browsing.bookmarks, page].slice(-200) } }))
  }
  const removeBookmark = (url: string) => setConfig(c => ({ ...c, browsing: { ...c.browsing, bookmarks: c.browsing.bookmarks.filter(b => b.url !== url) } }))

  async function sendToOther() {
    try { await sendPage({ url: tab.url, title: tab.title }); setNotice('Sent. It shows on your other computer’s Browser start page.') }
    catch (e) { setError(errorText(e, 'Couldn’t send the page')) }
  }

  return <div className="browser">
    <div className="browser-tabs" role="tablist">
      {tabs.map(t => <div key={t.id} className={`browser-tab${t.id === tab.id ? ' on' : ''}`} role="tab" aria-selected={t.id === tab.id}>
        <button className="browser-tab-name" title={t.url || 'New tab'} onClick={() => setCurrent(t.id)}>{t.started ? (t.loading && !t.title ? 'Loading…' : pageName(t)) : 'New tab'}</button>
        {t.started && <button className="browser-tab-close" title="Move to its own tab (like a book or PDF)" onClick={() => moveOut(t.id)}><PanelTopOpen size={12} /></button>}
        <button className="browser-tab-close" title="Close tab" onClick={() => closeTab(t.id)}><X size={12} /></button>
      </div>)}
      <button className="browser-tab-new" title="New tab" onClick={() => newTab()}><Plus size={14} /></button>
    </div>
    <form className="browser-bar" onSubmit={e => { e.preventDefault(); open(typed) }}>
      <button type="button" className="cal-icon" title="Back" disabled={!tab.started} onClick={() => void browserGo(tab.id, 'back')}><ArrowLeft size={15} /></button>
      <button type="button" className="cal-icon" title="Forward" disabled={!tab.started} onClick={() => void browserGo(tab.id, 'forward')}><ArrowRight size={15} /></button>
      <button type="button" className="cal-icon" title={tab.loading ? 'Stop' : 'Reload'} disabled={!tab.started} onClick={() => void browserGo(tab.id, tab.loading ? 'stop' : 'reload')}>{tab.loading ? <X size={15} /> : <RotateCw size={15} />}</button>
      <AdShield url={tab.url} />
      <input ref={address} value={typed} onChange={e => setTyped(e.target.value)} onFocus={e => e.target.select()} placeholder="Search, or type a web address" spellCheck={false} />
      <button type="button" className={`cal-icon${marked ? ' starred' : ''}`} disabled={!isWeb} title={marked ? 'Remove the bookmark' : 'Bookmark this page'} onClick={toggleBookmark}><Star size={15} fill={marked ? 'currentColor' : 'none'} /></button>
      <button type="button" className="cal-icon" disabled={!isWeb || !isTauri()} title="Send this page to your other computer" onClick={() => void sendToOther()}><Send size={15} /></button>
      <button type="button" className="cal-icon" disabled={!isWeb} title="Open this page in your own browser (Safari, Chrome…)" onClick={() => void openExternal(tab.url).catch(e => setError(String(e)))}><ExternalLink size={15} /></button>
      <button type="button" className="ghost" title="Open ChatGPT (with this page's address, ready for you to ask about it)" onClick={() => void askChatGPT(tab.url ? `About this page: ${tab.title ? `"${tab.title}" ` : ''}${tab.url}\n\n` : undefined)}><MessageCircleQuestion size={14} /> ChatGPT</button>
    </form>
    {error && <p className="cal-error">{error}</p>}
    <PopupBar tab={tab.id} />
    {notice && <p className="browser-notice">{notice} <button className="ghost" onClick={() => setNotice('')}><X size={12} /></button></p>}
    <Downloads />
    <div ref={area} className="browser-area">
      {!tab.started && <StartPage onOpen={url => { setTyped(url); open(url) }} onRemoveBookmark={removeBookmark} />}
    </div>
  </div>
}

/** Files web pages downloaded: open them, show them in their folder, or send them to the other computer. */
function Downloads() {
  const downloads = useStore(downloadsStore)
  if (!downloads.length) return null
  return <div className="browser-downloads">
    {downloads.map(d => <div key={d.url} className={`browser-download ${d.state}`}>
      <DownloadIcon size={14} />
      <span className="grow" title={d.path || d.url}>{d.path ? fileName(d.path) : d.url}</span>
      <small>{d.state === 'started' ? 'Downloading…' : d.state === 'done' ? 'In Downloads' : 'Failed'}</small>
      {d.state === 'done' && d.path && <>
        <button className="ghost" onClick={() => void openPath(d.path)}>Open</button>
        <button className="ghost" title="Show in its folder" onClick={() => void openPath(folderOf(d.path))}><FolderOpen size={13} /></button>
        <button className="ghost" title="Send this file to your other computer" onClick={() => { queueForSending([d.path]); dismissDownload(d.url) }}><Laptop size={13} /> Send</button>
      </>}
      <button className="ghost" title="Hide" onClick={() => dismissDownload(d.url)}><X size={12} /></button>
    </div>)}
  </div>
}

function StartPage({ onOpen, onRemoveBookmark }: { onOpen: (url: string) => void; onRemoveBookmark: (url: string) => void }) {
  const bookmarks = useConfig().browsing.bookmarks
  const history = useStore(historyStore)
  const sent = useSentPages()
  const recent = history.slice(0, 8)
  return <div className="browser-start">
    <Globe size={30} />
    <h3>Browse the web inside BridgeDeck</h3>
    <p>Type a web address or a search above, or start here.</p>
    {sent.length > 0 && <section className="browser-section sent">
      <h4><Laptop size={13} /> From your other computer</h4>
      <div className="browser-links">{sent.map(p => <button key={p.blockId} title={p.url} onClick={() => { void markSentOpened(p.blockId).catch(() => undefined); onOpen(p.url) }}>{pageName(p)}</button>)}</div>
    </section>}
    {bookmarks.length > 0 && <section className="browser-section">
      <h4><Star size={13} /> Bookmarks</h4>
      <div className="browser-links">{bookmarks.map(b => <span key={b.url} className="browser-link"><button title={b.url} onClick={() => onOpen(b.url)}>{b.name}</button><button className="browser-link-remove" title={`Remove ${b.name}`} onClick={() => onRemoveBookmark(b.url)}><X size={11} /></button></span>)}</div>
    </section>}
    <section className="browser-section">
      <h4>Start</h4>
      <div className="browser-links">{START.map(s => <button key={s.url} onClick={() => onOpen(s.url)}>{s.name}</button>)}</div>
    </section>
    {recent.length > 0 && <section className="browser-section">
      <h4><Clock size={13} /> Recently visited <button className="ghost" title="Clear history" onClick={clearHistory}><Trash2 size={12} /> Clear</button></h4>
      <div className="browser-history">{recent.map(h => <button key={h.url} title={h.url} onClick={() => onOpen(h.url)}><span>{pageName(h)}</span><small>{siteOf(h.url)}</small></button>)}</div>
    </section>}
    <p className="hint">Websites can't reach BridgeDeck or your files. Sign-ins are remembered, like a normal browser. Downloads go to your Downloads folder.</p>
  </div>
}
