import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Clock, Globe, Search, Send } from 'lucide-react'
import { useConfig } from '../core/config'
import { MOD, runShortcut } from '../core/shortcuts'
import { useStore } from '../core/store'
import { openWebTab, type DynamicTab } from '../core/tabs'
import { historyStore, markSentOpened, useSentPages } from '../features/browser/state'
import { pageName, siteOf } from '../features/browser/model'
import { looksLikeUrl } from './search'
import { apps, findApps, launch, type App } from './apps'

/** Sites shown before any bookmarks are made. */
const STARTER_SITES = [
  { name: 'YouTube', url: 'https://www.youtube.com/' },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/' },
  { name: 'Google Scholar', url: 'https://scholar.google.com/' },
  { name: 'Khan Academy', url: 'https://www.khanacademy.org/' },
  { name: 'Wolfram Alpha', url: 'https://www.wolframalpha.com/' },
  { name: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
]

/** An app's tile: its icon on its colour, and its name. */
export function AppTile({ app, onOpen, small }: { app: App; onOpen: () => void; small?: boolean }) {
  const Icon = app.icon
  return <button className={small ? 'app-tile small' : 'app-tile'} onClick={onOpen} title={app.about}>
    <span className="app-tile__icon" style={{ background: app.color }}><Icon size={small ? 18 : 22} /></span>
    <span className="app-tile__name">{app.title}</span>
  </button>
}

/** A site's tile: its first letter on a colour made from its name (pages can't load site icons). */
function SiteTile({ name, url, onOpen }: { name: string; url: string; onOpen: () => void }) {
  const site = siteOf(url) || name
  const hue = [...site].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return <button className="site-tile" onClick={onOpen} title={url}>
    <span className="site-tile__mark" style={{ background: `hsl(${hue} 55% 42%)` }}>{(name || site).charAt(0).toUpperCase()}</span>
    <span className="site-tile__name">{name || site}</span>
  </button>
}

/** The start page (Home's top, and every new tab): one box to open an app or a web page or search
 *  the web, the apps, the sites you use and the pages sent from your other computer. `tab`: the new
 *  tab it's in, which turns into what's opened. */
export function StartPage({ tab, focus }: { tab?: DynamicTab; focus?: boolean }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const config = useConfig()
  const history = useStore(historyStore)
  const sent = useSentPages()
  const from = tab?.id

  useEffect(() => { if (focus) input.current?.focus() }, [focus])

  const q = query.trim()
  // What Enter does, then the other choices: apps first, then the web.
  const choices = useMemo(() => {
    if (!q) return []
    const out: Array<{ key: string; label: string; detail: string; icon: 'app' | 'web' | 'search'; app?: App; run: () => void }> = []
    for (const app of findApps(q).slice(0, 4)) out.push({ key: `app:${app.id}`, label: app.title, detail: app.about, icon: 'app', app, run: () => launch(app.id, from) })
    const web = { key: 'web', label: looksLikeUrl(q) ? `Go to ${q}` : `Search the web for “${q}”`, detail: looksLikeUrl(q) ? 'Opens here' : 'DuckDuckGo', icon: looksLikeUrl(q) ? 'web' as const : 'search' as const, run: () => openWebTab(q, from) }
    // A web address goes first; otherwise an app whose name starts with what's typed.
    if (looksLikeUrl(q) || !out.some(o => o.label.toLowerCase().startsWith(q.toLowerCase()))) out.unshift(web)
    else out.push(web)
    const seen = new Set<string>()
    for (const page of history.filter(p => p.url.toLowerCase().includes(q.toLowerCase()) || p.title.toLowerCase().includes(q.toLowerCase()))) {
      if (seen.has(page.url) || seen.size >= 3) continue
      seen.add(page.url)
      out.push({ key: `page:${page.url}`, label: pageName(page), detail: page.url, icon: 'web', run: () => openWebTab(page.url, from) })
    }
    return out
  }, [q, history, from])
  useEffect(() => setPicked(0), [q])

  const sites = config.browsing.bookmarks.length ? config.browsing.bookmarks.slice(0, 12) : STARTER_SITES
  const recent = useMemo(() => {
    const seen = new Set<string>()
    return history.filter(p => { const site = siteOf(p.url); if (!site || seen.has(site)) return false; seen.add(site); return true }).slice(0, 6)
  }, [history])

  return <div className="start">
    <form className="start-search" onSubmit={e => { e.preventDefault(); choices[picked]?.run() }} role="search">
      <Search size={18} />
      <input ref={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="Open an app, search the web, or type a web address" spellCheck={false} autoComplete="off" aria-label="Open an app or search the web"
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setPicked(i => Math.min(i + 1, choices.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setPicked(i => Math.max(i - 1, 0)) }
          if (e.key === 'Escape') setQuery('')
        }} />
      <button type="button" className="start-search__more" title={`Search notes, books, calendar and more (${MOD} K)`} onClick={() => runShortcut('search')}><kbd>{MOD}K</kbd></button>
      {choices.length > 0 && <div className="start-choices" role="listbox">
        {choices.map((c, i) => {
          const Icon = c.app?.icon
          return <button type="button" key={c.key} role="option" aria-selected={i === picked} className={i === picked ? 'on' : ''} onMouseEnter={() => setPicked(i)} onClick={c.run}>
            {c.app && Icon ? <span className="start-choice__app" style={{ background: c.app.color }}><Icon size={14} /></span> : c.icon === 'search' ? <Search size={15} /> : <Globe size={15} />}
            <span className="grow"><strong>{c.label}</strong><small>{c.detail}</small></span>
            {i === picked && <ArrowRight size={14} />}
          </button>
        })}
      </div>}
    </form>

    <section className="start-section">
      <h2>Apps</h2>
      <div className="app-grid">
        {apps().map(app => <AppTile key={app.id} app={app} onOpen={() => launch(app.id, from)} />)}
      </div>
    </section>

    {sent.length > 0 && <section className="start-section">
      <h2><Send size={14} /> From your other computer</h2>
      <div className="start-list">
        {sent.slice(0, 4).map(p => <button key={p.blockId} onClick={() => { void markSentOpened(p.blockId); openWebTab(p.url, from) }}><Globe size={14} /><span className="grow"><strong>{p.title || siteOf(p.url)}</strong><small>{p.from} · {siteOf(p.url)}</small></span></button>)}
      </div>
    </section>}

    <section className="start-section">
      <h2><Globe size={14} /> Sites</h2>
      <div className="site-grid">
        {sites.map(s => <SiteTile key={s.url} name={s.name} url={s.url} onOpen={() => openWebTab(s.url, from)} />)}
      </div>
    </section>

    {recent.length > 0 && <section className="start-section">
      <h2><Clock size={14} /> Recently visited</h2>
      <div className="start-list">
        {recent.map(p => <button key={p.url} onClick={() => openWebTab(p.url, from)}><Globe size={14} /><span className="grow"><strong>{pageName(p)}</strong><small>{siteOf(p.url)}</small></span></button>)}
      </div>
    </section>}
  </div>
}

/** A new tab: the start page, ready to type in. */
export default function NewTabPage({ tab, active }: { tab: DynamicTab; active: boolean }) {
  return <div className="newtab"><StartPage tab={tab} focus={active} /></div>
}
