import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AppWindow, MessageCircleQuestion, Pin, PinOff, RefreshCw, Search, Settings, X } from 'lucide-react'
import { chatPanelStore, toggleChatPanel } from '../core/chatgpt'
import { hydratedStore } from '../core/config'
import { lastInGroupStore, pinsStore, togglePin } from '../core/pins'
import { refreshAll } from '../core/refresh'
import { MOD, runShortcut, tabMenuStore } from '../core/shortcuts'
import { useStore, type Store } from '../core/store'
import { activateTab, closeTab, tabsStore } from '../core/tabs'
import { features } from '../features/registry'
import { GROUPS, groupOf, type TabGroup } from '../features/groups'
import type { FeatureManifest } from '../features/features'
import { CodeChip } from '../features/messages/CodeChip'
import { SpotifyMini } from '../features/spotify/SpotifyMini'
import { ChecklistPopup } from '../features/notes/ChecklistPopup'
import { logActivity } from '../core/activity'
import { SystemMeter } from './SystemMeter'

const pages = features.filter(feature => feature.Page)
const byId = (id: string) => pages.find(feature => feature.id === id)
const itemsOf = (group: TabGroup) => group.items.map(byId).filter((f): f is FeatureManifest => !!f)
const iconFor = (kind: string) => features.find(feature => feature.tabKinds?.[kind])?.icon ?? AppWindow
/** The order Ctrl+Tab walks: every page, group by group. */
const ORDER = GROUPS.flatMap(itemsOf).map(feature => feature.id)

function Badge({ store }: { store: Store<number> }) {
  const count = useStore(store)
  if (!count) return null
  return <em className="tab-badge" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</em>
}

/** A dot on a group when anything in it has something new. */
function useAnyBadge(stores: Store<number>[]) {
  return useSyncExternalStore(
    listener => { const offs = stores.map(store => store.subscribe(listener)); return () => offs.forEach(off => off()) },
    () => stores.some(store => store.get() > 0),
  )
}

/** A main tab. With more than one page in its group, the pages show in a small menu while the pointer
 *  is over it (or it has keyboard focus), each with a pin to put it on the bar by itself. */
function GroupTab({ group, active }: { group: TabGroup; active: string }) {
  const items = itemsOf(group)
  const pins = useStore(pinsStore)
  const last = useStore(lastInGroupStore)[group.id]
  const [open, setOpen] = useState(false)
  const timer = useRef<number>()
  const tab = useRef<HTMLButtonElement>(null)
  // Placed against the window: the tab strip scrolls sideways, which would clip a menu inside it.
  const [at, setAt] = useState({ top: 0, left: 0 })
  const isActive = items.some(item => item.id === active)
  const dot = useAnyBadge(items.flatMap(item => item.badge ? [item.badge] : []))
  const single = items.length === 1
  const Icon = group.icon

  useEffect(() => { if (open) { tabMenuStore.set(true); return () => tabMenuStore.set(false) } }, [open])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (!items.length) return null

  // A short pause before opening (so passing over the bar doesn't flash menus) and before closing
  // (so moving down into the menu doesn't close it).
  const later = (next: boolean, ms: number) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const r = tab.current?.getBoundingClientRect()
      if (next && r) setAt({ top: r.bottom + 6, left: r.left })
      setOpen(next)
    }, ms)
  }
  const go = (id: string) => { activateTab(id); setOpen(false) }
  const target = isActive ? active : items.find(item => item.id === last)?.id ?? items[0].id

  return <div className="tab-group" onMouseEnter={() => !single && later(true, 120)} onMouseLeave={() => later(false, 180)}
    onFocus={() => !single && later(true, 0)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) later(false, 0) }}
    onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
    <button ref={tab} role="tab" aria-selected={isActive} aria-haspopup={single ? undefined : 'menu'} aria-expanded={single ? undefined : open}
      className={isActive ? 'tab active' : 'tab'} onClick={() => go(target)} title={single ? group.title : undefined}>
      <Icon size={15} /><span>{group.title}</span>
      {single && items[0].badge ? <Badge store={items[0].badge} /> : dot && <i className="tab-dot" aria-label="Something new" />}
    </button>
    {open && <div className="tab-menu" role="menu" aria-label={group.title} style={at}>
      {items.map(({ id, title, icon: ItemIcon, badge }) => <div key={id} className={id === active ? 'tab-menu__item active' : 'tab-menu__item'}>
        <button role="menuitem" onClick={() => go(id)}><ItemIcon size={15} /><span>{title}</span>{badge && <Badge store={badge} />}</button>
        <button className="tab-menu__pin" onClick={() => togglePin(id)} title={pins.includes(id) ? `Unpin ${title}` : `Pin ${title} to the bar`} aria-label={pins.includes(id) ? `Unpin ${title}` : `Pin ${title}`}>
          {pins.includes(id) ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
      </div>)}
    </div>}
  </div>
}

/** The bar: Search and the checklist, the main tabs (groups), pinned pages, open dynamic tabs, then the
 *  window's actions. */
export default function TabBar() {
  const { active, dynamic } = useStore(tabsStore)
  const hydrated = useStore(hydratedStore)
  const chatOpen = useStore(chatPanelStore).open
  const pins = useStore(pinsStore).map(byId).filter((f): f is FeatureManifest => !!f)

  // Remember the page last used in each group: clicking the group opens it again.
  useEffect(() => {
    const group = groupOf(active)
    if (group && lastInGroupStore.get()[group.id] !== active) lastInGroupStore.set(map => ({ ...map, [group.id]: active }))
    logActivity('tabs', `Opened ${active}`)
  }, [active])

  // Ctrl+Tab / Ctrl+Shift+Tab move between pages, like a browser.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab') return
      event.preventDefault()
      const order = [...ORDER, ...tabsStore.get().dynamic.map(tab => tab.id), 'settings']
      const index = order.indexOf(tabsStore.get().active)
      activateTab(order[(index + (event.shiftKey ? -1 : 1) + order.length) % order.length])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header className="tabbar">
      <div className="tabbar-lead">
        <div className="brand-mark" aria-hidden="true" />
        <button className="search-pill" onClick={() => runShortcut('search')} title={`Search everything (${MOD} K)`} aria-label="Search"><Search size={14} /><span>Search</span><kbd>{MOD}K</kbd></button>
        <ChecklistPopup />
      </div>
      <nav className="tab-strip" role="tablist" aria-label="BridgeDeck tabs">
        {GROUPS.map(group => <GroupTab key={group.id} group={group} active={active} />)}
        {!!pins.length && <span className="tab-divider" aria-hidden="true" />}
        {pins.map(({ id, title, icon: Icon, badge }) => (
          <button key={id} role="tab" aria-selected={active === id} className={active === id ? 'tab pinned active' : 'tab pinned'} onClick={() => activateTab(id)} onAuxClick={event => { if (event.button === 1) togglePin(id) }} title={`${title} (pinned; middle-click to unpin)`}>
            <Icon size={15} /><span>{title}</span>{badge && <Badge store={badge} />}
          </button>
        ))}
        {!!dynamic.length && <span className="tab-divider" aria-hidden="true" />}
        {dynamic.map(tab => { const Icon = iconFor(tab.kind); return (
          <div key={tab.id} role="tab" aria-selected={active === tab.id} className={active === tab.id ? 'tab dynamic active' : 'tab dynamic'}
            onClick={() => activateTab(tab.id)} onAuxClick={event => { if (event.button === 1) closeTab(tab.id) }} title={tab.title}>
            <Icon size={15} /><span>{tab.title}</span>
            <button className="tab-close" aria-label={`Close ${tab.title}`} onClick={event => { event.stopPropagation(); closeTab(tab.id) }}><X size={13} /></button>
          </div>
        ) })}
      </nav>
      <div className="tab-actions">
        <SystemMeter />
        <CodeChip />
        <SpotifyMini />
        {!hydrated && <span className="save-state">Loading…</span>}
        <button className={chatOpen ? 'icon-button active' : 'icon-button'} onClick={toggleChatPanel} title={`ChatGPT (side panel, ${MOD} J)`} aria-label="ChatGPT"><MessageCircleQuestion size={15} /></button>
        <button className="icon-button" onClick={() => void refreshAll()} title="Refresh" aria-label="Refresh"><RefreshCw size={15} /></button>
        <button className={active === 'settings' ? 'icon-button active' : 'icon-button'} onClick={() => activateTab('settings')} title="Settings" aria-label="Settings"><Settings size={15} /></button>
      </div>
    </header>
  )
}
