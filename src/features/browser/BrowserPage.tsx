import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowRight, Globe, MessageCircleQuestion, RotateCw, X } from 'lucide-react'
import { browserGo, browserHide, browserShow, isTauri } from '../../lib/bridge'
import { askChatGPT } from '../../core/chatgpt'

const TAB = '1'
const START = [
  { name: 'Search', url: 'https://duckduckgo.com/' },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/' },
  { name: 'Google Scholar', url: 'https://scholar.google.com/' },
  { name: 'Khan Academy', url: 'https://www.khanacademy.org/' },
  { name: 'Wolfram Alpha', url: 'https://www.wolframalpha.com/' },
  { name: 'YouTube', url: 'https://www.youtube.com/' },
]

/** Websites inside BridgeDeck: the page is a native web view laid over the area below the
 *  address bar (src-tauri/src/browser.rs), hidden while another tab is showing. */
export default function BrowserPage({ active }: { active: boolean }) {
  const area = useRef<HTMLDivElement>(null)
  const [started, setStarted] = useState(false)
  const [typed, setTyped] = useState('')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<string | null>(null)

  // Keep the page over the area: on show, resize and layout changes.
  useEffect(() => {
    if (!isTauri() || !started) return
    const el = area.current
    if (!active || !el) { void browserHide(TAB).catch(() => undefined); return }
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
    // The area can also move without resizing (a notice above it appears or goes): check now and then.
    const timer = window.setInterval(place, 400)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.clearInterval(timer); void browserHide(TAB).catch(() => undefined) }
  }, [active, started])

  useEffect(() => {
    const stops = [
      listen<{ tab: string; url: string; loading: boolean }>('browser-page', e => { if (e.payload.tab === TAB) { setUrl(e.payload.url); setTyped(e.payload.url); setLoading(e.payload.loading) } }),
      listen<{ tab: string; title: string }>('browser-title', e => { if (e.payload.tab === TAB) setTitle(e.payload.title) }),
    ]
    return () => stops.forEach(p => void p.then(stop => stop()).catch(() => undefined))
  }, [])

  function open(where: string) {
    if (!where.trim()) return
    if (!started) { pending.current = where; setStarted(true); return }
    const el = area.current
    if (!el) return
    const r = el.getBoundingClientRect()
    void browserShow(TAB, where, r.left, r.top, r.width, r.height).catch(e => setError(String(e)))
  }

  return <div className="browser">
    <form className="browser-bar" onSubmit={e => { e.preventDefault(); open(typed) }}>
      <button type="button" className="cal-icon" title="Back" disabled={!started} onClick={() => void browserGo(TAB, 'back')}><ArrowLeft size={15} /></button>
      <button type="button" className="cal-icon" title="Forward" disabled={!started} onClick={() => void browserGo(TAB, 'forward')}><ArrowRight size={15} /></button>
      <button type="button" className="cal-icon" title={loading ? 'Stop' : 'Reload'} disabled={!started} onClick={() => void browserGo(TAB, loading ? 'stop' : 'reload')}>{loading ? <X size={15} /> : <RotateCw size={15} />}</button>
      <input value={typed} onChange={e => setTyped(e.target.value)} onFocus={e => e.target.select()} placeholder="Search, or type a web address" spellCheck={false} />
      <button type="button" className="ghost" title="Open ChatGPT (with this page's address, ready for you to ask about it)" onClick={() => void askChatGPT(url ? `About this page: ${title ? `"${title}" ` : ''}${url}\n\n` : undefined)}><MessageCircleQuestion size={14} /> ChatGPT</button>
    </form>
    {error && <p className="cal-error">{error}</p>}
    <div ref={area} className="browser-area">
      {!started && <div className="browser-start">
        <Globe size={30} />
        <h3>Browse the web inside BridgeDeck</h3>
        <p>Type a web address or a search above, or start here.</p>
        <div className="browser-links">{START.map(s => <button key={s.url} onClick={() => { setTyped(s.url); open(s.url) }}>{s.name}</button>)}</div>
        <p className="hint">Websites can't reach BridgeDeck or your files. Sign-ins are remembered, like a normal browser.</p>
      </div>}
    </div>
  </div>
}
