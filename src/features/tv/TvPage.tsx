import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowRight, ExternalLink, History, LayoutGrid, Maximize2, Minimize2, Plus, RotateCw, Trash2, Tv, X } from 'lucide-react'
import { browserGo, browserPause, isTauri, openExternal } from '../../lib/bridge'
import { usePagePlacement } from '../browser/placement'
import { setConfig, useConfig } from '../../core/config'
import { useOverlayOpen } from '../../core/shortcuts'
import { addWatched, SERVICES, serviceFor, shortcutName, shortcutUrl, type Watched } from './model'
import { AdShield } from '../browser/WebSettings'
import PopupBar from '../browser/PopupBar'
import { blockerChangedStore } from '../browser/state'
import { useStore } from '../../core/store'

// The TV tab has its own web view, apart from the Browser tab's (src-tauri/src/browser.rs).
const TAB = 'tv'
const WATCHED_KEY = 'bridgedeck.tv.watched'

/** "Continue watching", kept on this computer (each computer has its own sign-ins). */
function loadWatched(): Watched[] {
  try {
    const list = JSON.parse(localStorage.getItem(WATCHED_KEY) || '[]')
    return Array.isArray(list) ? list.filter((w): w is Watched => typeof w?.url === 'string' && typeof w?.title === 'string' && typeof w?.at === 'number') : []
  } catch { return [] }
}

/** Streaming sites inside BridgeDeck: pick a service (or one of your own shortcuts) and it plays
 *  in a web view laid over the area below the bar. "Full window" hides BridgeDeck's tab bar. */
export default function TvPage({ active: onScreen }: { active: boolean }) {
  const config = useConfig()
  // Hidden under Search everything and the shortcuts list (it would cover them).
  const overlay = useOverlayOpen()
  const active = onScreen && !overlay
  const blockerChanged = useStore(blockerChangedStore)
  const area = useRef<HTMLDivElement>(null)
  const [watching, setWatching] = useState(false)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [full, setFull] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<{ name: string; url: string } | null>(null)
  const pending = useRef<string | null>(null)
  const [watched, setWatched] = useState(loadWatched)

  function rememberPage(page: Watched) {
    setWatched(list => {
      const next = addWatched(list, page)
      try { localStorage.setItem(WATCHED_KEY, JSON.stringify(next)) } catch { /* a convenience only */ }
      return next
    })
  }

  // Keep the page over the area while watching; hide it on the service grid or another tab.
  usePagePlacement(TAB, active && watching, area, () => { const go = pending.current; pending.current = null; return go }, setError, [full, blockerChanged])

  useEffect(() => {
    const stops = [
      listen<{ tab: string; url: string; loading: boolean }>('browser-page', e => { if (e.payload.tab === TAB) { setUrl(e.payload.url); setLoading(e.payload.loading) } }),
      listen<{ tab: string; title: string }>('browser-title', e => { if (e.payload.tab === TAB) setTitle(e.payload.title) }),
    ]
    return () => stops.forEach(p => void p.then(stop => stop()).catch(() => undefined))
  }, [])

  // Streaming sites change address without reloading (an episode starting): keep the latest page and title.
  useEffect(() => {
    if (watching && /^https?:/.test(url)) rememberPage({ url, title, at: Date.now() })
  }, [watching, url, title])

  // Leaving the TV tab pauses the show (it would otherwise keep playing, unseen).
  const wasActive = useRef(onScreen)
  useEffect(() => {
    if (wasActive.current && !onScreen && watching && isTauri()) void browserPause(TAB).catch(() => undefined)
    wasActive.current = onScreen
  }, [onScreen, watching])

  // Full window: BridgeDeck's tab bar is hidden while the TV tab is on screen.
  useEffect(() => {
    document.body.classList.toggle('tv-full', full && onScreen)
    return () => document.body.classList.remove('tv-full')
  }, [full, onScreen])

  function watch(where: string) {
    pending.current = where
    setUrl(where)
    setTitle('')
    setWatching(true)
  }

  function saveShortcut() {
    if (!adding) return
    const address = shortcutUrl(adding.url)
    if (!address) { setError('That isn’t a web address.'); return }
    const name = adding.name.trim() || shortcutName(address)
    setConfig(c => ({ ...c, tv: { shortcuts: [...c.tv.shortcuts.filter(s => s.url !== address), { name, url: address }].slice(0, 40) } }))
    setAdding(null)
    setError('')
  }

  const removeShortcut = (address: string) => setConfig(c => ({ ...c, tv: { shortcuts: c.tv.shortcuts.filter(s => s.url !== address) } }))

  if (!watching) return <div className="tv">
    <div className="tv-head"><Tv size={18} /><h2>TV</h2><span className="hint">Pick a service. Sign in with your own account; the free ones need none.</span></div>
    {error && <p className="cal-error">{error}</p>}
    {watched.length > 0 && <>
      <h3 className="tv-group"><History size={12} /> Continue watching</h3>
      <div className="tv-grid">{watched.map(w => {
        const service = serviceFor(w.url, config.tv.shortcuts)
        return <Tile key={w.url} name={service.name} detail={w.title && w.title !== service.name ? w.title : undefined} color={service.color} onClick={() => watch(w.url)} onRemove={() => setWatched(list => { const next = list.filter(x => x.url !== w.url); try { localStorage.setItem(WATCHED_KEY, JSON.stringify(next)) } catch { /* a convenience only */ } return next })} />
      })}</div>
    </>}
    <h3 className="tv-group">Free</h3>
    <div className="tv-grid">{SERVICES.filter(s => s.free).map(s => <Tile key={s.url} name={s.name} color={s.color} onClick={() => watch(s.url)} />)}</div>
    <h3 className="tv-group">With a subscription</h3>
    <div className="tv-grid">{SERVICES.filter(s => !s.free).map(s => <Tile key={s.url} name={s.name} color={s.color} onClick={() => watch(s.url)} />)}</div>
    <h3 className="tv-group">Your shortcuts</h3>
    <div className="tv-grid">
      {config.tv.shortcuts.map(s => <Tile key={s.url} name={s.name} color="#2a3545" onClick={() => watch(s.url)} onRemove={() => removeShortcut(s.url)} />)}
      {adding ? <form className="tv-add" onSubmit={e => { e.preventDefault(); saveShortcut() }}>
        <input autoFocus placeholder="Web address, e.g. nebula.tv" value={adding.url} onChange={e => setAdding({ ...adding, url: e.target.value })} />
        <input placeholder="Name (optional)" value={adding.name} onChange={e => setAdding({ ...adding, name: e.target.value })} />
        <div className="actions"><button disabled={!adding.url.trim()}>Add</button><button type="button" className="secondary" onClick={() => setAdding(null)}>Cancel</button></div>
      </form> : <button className="tv-tile tv-tile-add" onClick={() => setAdding({ name: '', url: '' })}><Plus size={22} /><span>Add a site</span></button>}
    </div>
    <p className="hint">If a service says this browser isn’t supported or won’t play (some use copy protection BridgeDeck’s built-in web view can’t do), use “Open in my browser” while watching.</p>
  </div>

  return <div className={`tv tv-watching${full ? ' tv-full-window' : ''}`}>
    <div className="tv-bar">
      <button className="cal-icon" title="All services" onClick={() => { setWatching(false); setFull(false) }}><LayoutGrid size={15} /></button>
      <button className="cal-icon" title="Back" onClick={() => void browserGo(TAB, 'back')}><ArrowLeft size={15} /></button>
      <button className="cal-icon" title="Forward" onClick={() => void browserGo(TAB, 'forward')}><ArrowRight size={15} /></button>
      <button className="cal-icon" title={loading ? 'Stop' : 'Reload'} onClick={() => void browserGo(TAB, loading ? 'stop' : 'reload')}>{loading ? <X size={15} /> : <RotateCw size={15} />}</button>
      <span className="grow tv-title" title={url}>{title || url}</span>
      <AdShield url={url} />
      <button className="ghost" disabled={!/^https?:/.test(url)} title="Open this in your own browser (Safari, Chrome…), e.g. when a service won’t play here" onClick={() => void openExternal(url).catch(e => setError(String(e)))}><ExternalLink size={14} /> Open in my browser</button>
      <button className="ghost" title={full ? 'Show BridgeDeck’s tabs again' : 'Hide BridgeDeck’s tabs so the show fills the window'} onClick={() => setFull(f => !f)}>{full ? <Minimize2 size={14} /> : <Maximize2 size={14} />} {full ? 'Exit full window' : 'Full window'}</button>
    </div>
    {error && <p className="cal-error">{error}</p>}
    <PopupBar tab={TAB} />
    <div ref={area} className="tv-area">{!isTauri() && <p className="hint">Shows play here in the BridgeDeck app.</p>}</div>
  </div>
}

function Tile({ name, detail, color, onClick, onRemove }: { name: string; detail?: string; color: string; onClick: () => void; onRemove?: () => void }) {
  return <div className="tv-tile-wrap">
    <button className="tv-tile" style={{ background: color }} onClick={onClick} title={detail}><span>{name}</span>{detail && <small className="tv-tile-detail">{detail}</small>}</button>
    {onRemove && <button className="tv-remove" title={`Remove ${name}`} onClick={onRemove}><Trash2 size={13} /></button>}
  </div>
}
