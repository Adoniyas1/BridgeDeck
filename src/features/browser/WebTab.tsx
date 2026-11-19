import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from 'lucide-react'
import { browserClose, browserGo, browserHas, isTauri, openExternal } from '../../lib/bridge'
import { browserCommandStore, useOverlayOpen } from '../../core/shortcuts'
import { useStore } from '../../core/store'
import { retitleTab, tabsStore, type DynamicTab } from '../../core/tabs'
import { pageName } from './model'
import { usePagePlacement } from './placement'
import PopupBar from './PopupBar'
import { blockerChangedStore, remember } from './state'
import { AdShield } from './WebSettings'

/** A web page in a BridgeDeck tab of its own, like a browser's tab: its own native page
 *  (src-tauri/src/browser.rs), made on first use, kept signed in. Closing the tab closes the page. */
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
  const address = useRef<HTMLInputElement>(null)
  const command = useStore(browserCommandStore)

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

  // Closing this tab closes its page.
  useEffect(() => () => { if (page && isTauri()) void browserClose(page).catch(() => undefined) }, [page])
  // ⌘L: the address bar, when this is the tab showing.
  useEffect(() => {
    if (command?.name === 'address' && tabsStore.get().active === tab.id) { address.current?.focus(); address.current?.select() }
  }, [command])

  function navigate(where: string) {
    if (!where.trim()) return
    go.current = where
    // The placement picks it up on its next check.
    setTyped(where)
  }

  if (!page) return <p className="hint">This tab has no page.</p>
  return <div className="browser">
    <form className="browser-bar" onSubmit={e => { e.preventDefault(); navigate(typed) }}>
      <button type="button" className="cal-icon" title="Back" onClick={() => void browserGo(page, 'back')}><ArrowLeft size={15} /></button>
      <button type="button" className="cal-icon" title="Forward" onClick={() => void browserGo(page, 'forward')}><ArrowRight size={15} /></button>
      <button type="button" className="cal-icon" title={loading ? 'Stop' : 'Reload'} onClick={() => void browserGo(page, loading ? 'stop' : 'reload')}>{loading ? <X size={15} /> : <RotateCw size={15} />}</button>
      <AdShield url={url} />
      <input ref={address} value={typed} onChange={e => setTyped(e.target.value)} onFocus={e => e.target.select()} placeholder="Search, or type a web address" spellCheck={false} />
      <button type="button" className="cal-icon" disabled={!/^https?:/.test(url)} title="Open this page in your own browser" onClick={() => void openExternal(url).catch(e => setError(String(e)))}><ExternalLink size={15} /></button>
    </form>
    {error && <p className="cal-error">{error}</p>}
    <PopupBar tab={page} />
    <div ref={area} className="browser-area" />
  </div>
}
