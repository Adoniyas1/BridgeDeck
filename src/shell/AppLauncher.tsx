import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LayoutGrid, Search } from 'lucide-react'
import { tabMenuStore } from '../core/shortcuts'
import { useStore, type Store } from '../core/store'
import { tabsStore, openOf } from '../core/tabs'
import { apps, areas, findApps, launch, type App } from './apps'

function Badge({ store }: { store: Store<number> }) {
  const count = useStore(store)
  if (!count) return null
  return <em className="tab-badge" aria-label={`${count} new`}>{count > 99 ? '99+' : count}</em>
}

/** Whether any app that isn't open has something new (its count would otherwise be out of sight). */
function useHiddenNews(open: string[]) {
  const stores = apps().filter(a => a.badge && !open.includes(a.id)).map(a => a.badge!)
  return useSyncExternalStore(
    listener => { const offs = stores.map(store => store.subscribe(listener)); return () => offs.forEach(off => off()) },
    () => stores.some(store => store.get() > 0),
  )
}

function LauncherTile({ app, onOpen }: { app: App; onOpen: () => void }) {
  const Icon = app.icon
  return <button className="launcher-tile" onClick={onOpen} title={app.about}>
    <span className="app-tile__icon" style={{ background: app.color }}><Icon size={20} /></span>
    <span className="launcher-tile__name">{app.title}</span>
    {app.badge && <Badge store={app.badge} />}
  </button>
}

/** The apps button at the start of the tab bar (like Microsoft's app launcher): every app by area,
 *  with a box to find one. Picking an app opens it in a tab of its own (or shows its tab). */
export function AppLauncher() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const tabs = useStore(tabsStore)
  const news = useHiddenNews(openOf(tabs))

  useEffect(() => { tabMenuStore.set(open); return () => tabMenuStore.set(false) }, [open])
  useEffect(() => {
    if (!open) { setQuery(''); return }
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  }, [open])

  const go = (id: string) => { setOpen(false); launch(id) }
  const found = query.trim() ? findApps(query) : null

  return <div className="launcher" ref={box}>
    <button className={open ? 'launcher-button active' : 'launcher-button'} onClick={() => setOpen(o => !o)} title="Apps" aria-label="Apps" aria-expanded={open}>
      <LayoutGrid size={17} />{news && <i className="tab-dot" aria-label="Something new" />}
    </button>
    {open && <div className="launcher-popup" role="dialog" aria-label="Apps">
      <label className="launcher-search"><Search size={14} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Find an app" aria-label="Find an app"
        onKeyDown={e => { if (e.key === 'Enter' && found?.[0]) go(found[0].id) }} /></label>
      <div className="launcher-body">
        {found
          ? (found.length ? <div className="launcher-grid">{found.map(app => <LauncherTile key={app.id} app={app} onOpen={() => go(app.id)} />)}</div> : <p className="hint">No app called that.</p>)
          : areas().map(({ area, apps: list }) => <section key={area}>
            <h3>{area}</h3>
            <div className="launcher-grid">{list.map(app => <LauncherTile key={app.id} app={app} onOpen={() => go(app.id)} />)}</div>
          </section>)}
      </div>
    </div>}
  </div>
}
