import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowRight, ExternalLink, PanelTopClose, RotateCw, X } from 'lucide-react'
import { browserClose, browserGo, browserHas, isTauri, openExternal } from '../../lib/bridge'
import { browserCommandStore, useOverlayOpen } from '../../core/shortcuts'
import { useStore } from '../../core/store'
import { activateTab, closeTab, retitleTab, type DynamicTab } from '../../core/tabs'
import { pageName } from './model'
import { usePagePlacement } from './placement'
import PopupBar from './PopupBar'
import { blockerChangedStore, remember } from './state'
import { AdShield } from './WebSettings'

/** A web page in a BridgeDeck tab of its own, moved out of the Browser (it keeps its place, sign-in
 *  and playback: it's the same page). Closing the tab closes the page; "Back to the Browser" returns
 *  it there. */
export default function WebTab({ tab, active: onScreen }: { tab: DynamicTab; active: boolean }) {
  const page = String(tab.params?.page ?? '')
  const overlay = useOverlayOpen()
  const blockerChanged = useStore(blockerChangedStore)
  const area = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState(String(tab.params?.url ?? ''))
  const [title, setTitle] = useState(String(tab.params?.title ?? ''))
  const [typed, setTyped] = useState(url)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const go = useRef<string | null>(null)
  const movedBack = useRef(false)

  // A page that isn't there any more (it was closed) opens again at its address.
  const [checked, setChecked] = useState(!isTauri())
  useEffect(() => {
    if (!isTauri() || !page) return
    void browserHas(page).then(has => { if (!has) go.current = url || 'https://duckduckgo.com/'; setChecked(true) }).catch(() => setChecked(true))
  }, [page])

  usePagePlacement(page, checked && onScreen && !overlay, area, () => { const g = go.current; go.current = null; return g }, setError, [blockerChanged])

  useEffect(() => {
    const stops = [
      listen<{ tab: string; url: string; loading: boolean }>('browser-page', e => {
        if (e.payload.tab !== page) return
        setUrl(e.payload.url); setTyped(e.payload.url); setLoading(e.payload.loading)
        if (!e.payload.loading) remember({ url: e.payload.url, title, at: Date.now() })
      }),
      listen<{ tab: string; title: string }>('browser-title', e => { if (e.payload.tab === page) setTitle(e.payload.title) }),
    ]
    return () => stops.forEach(p => void p.then(stop => stop()).catch(() => undefined))
  }, [page])

  useEffect(() => { retitleTab(tab.id, pageName({ url, title }).slice(0, 40) || 'Web page') }, [url, title])

  // Closing this tab closes its page (unless it went back to the Browser).
  useEffect(() => () => { if (!movedBack.current && page && isTauri()) void browserClose(page).catch(() => undefined) }, [page])

  function navigate(where: string) {
    if (!where.trim()) return
    go.current = where
    // The placement picks it up on its next check.
    setTyped(where)
  }

  function backToBrowser() {
    movedBack.current = true
    browserCommandStore.set({ name: 'adopt', page, url, title, at: Date.now() })
    closeTab(tab.id)
    activateTab('browser')
  }

  if (!page) return <p className="hint">This tab has no page.</p>
  return <div className="browser">
    <form className="browser-bar" onSubmit={e => { e.preventDefault(); navigate(typed) }}>
      <button type="button" className="cal-icon" title="Back" onClick={() => void browserGo(page, 'back')}><ArrowLeft size={15} /></button>
      <button type="button" className="cal-icon" title="Forward" onClick={() => void browserGo(page, 'forward')}><ArrowRight size={15} /></button>
      <button type="button" className="cal-icon" title={loading ? 'Stop' : 'Reload'} onClick={() => void browserGo(page, loading ? 'stop' : 'reload')}>{loading ? <X size={15} /> : <RotateCw size={15} />}</button>
      <AdShield url={url} />
      <input value={typed} onChange={e => setTyped(e.target.value)} onFocus={e => e.target.select()} placeholder="Search, or type a web address" spellCheck={false} />
      <button type="button" className="cal-icon" disabled={!/^https?:/.test(url)} title="Open this page in your own browser" onClick={() => void openExternal(url).catch(e => setError(String(e)))}><ExternalLink size={15} /></button>
      <button type="button" className="ghost" title="Put this page back in the Browser’s tabs" onClick={backToBrowser}><PanelTopClose size={14} /> Back to the Browser</button>
    </form>
    {error && <p className="cal-error">{error}</p>}
    <PopupBar tab={page} />
    <div ref={area} className="browser-area" />
  </div>
}
