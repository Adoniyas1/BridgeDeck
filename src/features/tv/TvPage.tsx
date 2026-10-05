import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowRight, ExternalLink, LayoutGrid, Maximize2, Minimize2, Plus, RotateCw, Trash2, Tv, X } from 'lucide-react'
import { browserGo, browserHide, browserPause, browserShow, isTauri, openExternal } from '../../lib/bridge'
import { setConfig, useConfig } from '../../core/config'
import { SERVICES, shortcutName, shortcutUrl } from './model'

// The TV tab has its own web view, apart from the Browser tab's (src-tauri/src/browser.rs).
const TAB = 'tv'

/** Streaming sites inside BridgeDeck: pick a service (or one of your own shortcuts) and it plays
 *  in a web view laid over the area below the bar. "Full window" hides BridgeDeck's tab bar. */
export default function TvPage({ active }: { active: boolean }) {
  const config = useConfig()
  const area = useRef<HTMLDivElement>(null)
  const [watching, setWatching] = useState(false)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [full, setFull] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<{ name: string; url: string } | null>(null)
  const pending = useRef<string | null>(null)

  // Keep the page over the area while watching; hide it on the service grid or another tab.
  useEffect(() => {
    if (!isTauri()) return
    const el = area.current
    if (!active || !watching || !el) { void browserHide(TAB).catch(() => undefined); return }
    let last = ''
    const place = () => {
      const r = el.getBoundingClientRect()
      const go = pending.current
      const at = [r.left, r.top, r.width, r.height].map(Math.round).join(',')
      if (at === last && !go) return
      last = at
      pending.current = null
      void browserShow(TAB, go, r.left, r.top, r.width, r.height).then(() => setError('')).catch(e => setError(String(e)))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    const timer = window.setInterval(place, 400)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.clearInterval(timer); void browserHide(TAB).catch(() => undefined) }
  }, [active, watching, full])

  useEffect(() => {
    const stops = [
      listen<{ tab: string; url: string; loading: boolean }>('browser-page', e => { if (e.payload.tab === TAB) { setUrl(e.payload.url); setLoading(e.payload.loading) } }),
      listen<{ tab: string; title: string }>('browser-title', e => { if (e.payload.tab === TAB) setTitle(e.payload.title) }),
    ]
    return () => stops.forEach(p => void p.then(stop => stop()).catch(() => undefined))
  }, [])

  // Leaving the TV tab pauses the show (it would otherwise keep playing, unseen).
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active && watching && isTauri()) void browserPause(TAB).catch(() => undefined)
    wasActive.current = active
  }, [active, watching])

  // Full window: BridgeDeck's tab bar is hidden while the TV tab is on screen.
  useEffect(() => {
    document.body.classList.toggle('tv-full', full && active)
    return () => document.body.classList.remove('tv-full')
  }, [full, active])

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
      <button className="ghost" disabled={!/^https?:/.test(url)} title="Open this in your own browser (Safari, Chrome…), e.g. when a service won’t play here" onClick={() => void openExternal(url).catch(e => setError(String(e)))}><ExternalLink size={14} /> Open in my browser</button>
      <button className="ghost" title={full ? 'Show BridgeDeck’s tabs again' : 'Hide BridgeDeck’s tabs so the show fills the window'} onClick={() => setFull(f => !f)}>{full ? <Minimize2 size={14} /> : <Maximize2 size={14} />} {full ? 'Exit full window' : 'Full window'}</button>
    </div>
    {error && <p className="cal-error">{error}</p>}
    <div ref={area} className="tv-area">{!isTauri() && <p className="hint">Shows play here in the BridgeDeck app.</p>}</div>
  </div>
}

function Tile({ name, color, onClick, onRemove }: { name: string; color: string; onClick: () => void; onRemove?: () => void }) {
  return <div className="tv-tile-wrap">
    <button className="tv-tile" style={{ background: color }} onClick={onClick}><span>{name}</span></button>
    {onRemove && <button className="tv-remove" title={`Remove ${name}`} onClick={onRemove}><Trash2 size={13} /></button>}
  </div>
}
