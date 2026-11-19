import { useEffect, useRef, useState } from 'react'
import { AppWindow, Columns2, Globe, MessageCircleQuestion, Pin, PinOff, Plus, RefreshCw, RotateCcw, Search, Settings, X } from 'lucide-react'
import { chatPanelStore, toggleChatPanel } from '../core/chatgpt'
import { hydratedStore } from '../core/config'
import { pinsStore, togglePin } from '../core/pins'
import { refreshAll } from '../core/refresh'
import { MOD, runShortcut, tabMenuStore } from '../core/shortcuts'
import { useStore, type Store } from '../core/store'
import { activateTab, barOrder, closeOtherTabs, closeTab, closeTabsRight, moveTab, newTab, openOf, reopenClosedTab, splitTab, tabsStore, unsplit, type DynamicTab } from '../core/tabs'
import { features } from '../features/registry'
import { CodeChip } from '../features/messages/CodeChip'
import { SpotifyMini } from '../features/spotify/SpotifyMini'
import { ChecklistPopup } from '../features/notes/ChecklistPopup'
import { CalculatorPopup } from './CalculatorPopup'
import { AppLauncher } from './AppLauncher'
import { logActivity } from '../core/activity'
import { SystemMeter } from './SystemMeter'
import type { LucideIcon } from 'lucide-react'

const kindIcon = (kind: string): LucideIcon => kind === 'web' ? Globe : kind === 'newtab' ? Search : features.find(feature => feature.tabKinds?.[kind])?.icon ?? AppWindow

/** What a tab shows: its icon, title, and unread count. */
function describe(id: string, dynamic: DynamicTab[]): { title: string; icon: LucideIcon; badge?: Store<number>; kind?: string } {
  if (id === 'settings') return { title: 'Settings', icon: Settings }
  const tab = dynamic.find(t => t.id === id)
  if (tab) return { title: tab.title || 'Untitled', icon: kindIcon(tab.kind), kind: tab.kind }
  const f = features.find(feature => feature.id === id)
  return { title: f?.title ?? id, icon: f?.icon ?? AppWindow, badge: f?.badge }
}

function Badge({ store }: { store: Store<number> }) {
  const count = useStore(store)
  if (!count) return null
  return <em className="tab-badge" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</em>
}

type Menu = { id: string; x: number; y: number }

/** A tab's right-click menu. */
function TabMenu({ menu, onClose }: { menu: Menu; onClose: () => void }) {
  const tabs = useStore(tabsStore)
  const pins = useStore(pinsStore)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    tabMenuStore.set(true)
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => { tabMenuStore.set(false); window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  }, [])
  const { id } = menu
  const order = barOrder(tabs, pins)
  const pinned = pins.includes(id)
  const run = (f: () => void) => () => { f(); onClose() }
  const items: Array<{ label: string; icon: LucideIcon; run: () => void; disabled?: boolean } | null> = [
    { label: 'New tab', icon: Plus, run: run(newTab) },
    null,
    { label: pinned ? 'Unpin' : 'Pin', icon: pinned ? PinOff : Pin, run: run(() => togglePin(id)) },
    tabs.split === id ? { label: 'Close split screen', icon: Columns2, run: run(unsplit) } : { label: 'Open beside (split screen)', icon: Columns2, run: run(() => splitTab(id)) },
    null,
    { label: 'Close', icon: X, run: run(() => closeTab(id)) },
    { label: 'Close other tabs', icon: X, run: run(() => closeOtherTabs(id, pins)), disabled: order.filter(t => t !== id && !pins.includes(t)).length === 0 },
    { label: 'Close tabs to the right', icon: X, run: run(() => closeTabsRight(id, pins)), disabled: order.indexOf(id) === order.length - 1 },
    { label: 'Reopen closed tab', icon: RotateCcw, run: run(reopenClosedTab), disabled: !tabs.closed?.length },
  ]
  return <div ref={box} className="tab-context" role="menu" style={{ top: menu.y, left: Math.min(menu.x, window.innerWidth - 240) }}>
    {items.map((item, i) => item ? <button key={item.label} role="menuitem" disabled={item.disabled} onClick={item.run}><item.icon size={14} /><span>{item.label}</span></button> : <hr key={i} />)}
  </div>
}

/** The bar, like a browser's: the apps button, the open tabs (pinned first; drag to reorder; middle-
 *  click or × to close; right-click for more), a new-tab button, then quick tools and Settings. */
export default function TabBar() {
  const tabs = useStore(tabsStore)
  const { active, dynamic, split } = tabs
  const hydrated = useStore(hydratedStore)
  const chatOpen = useStore(chatPanelStore).open
  const pins = useStore(pinsStore)
  const order = barOrder(tabs, pins)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const strip = useRef<HTMLElement>(null)

  useEffect(() => { logActivity('tabs', `Opened ${active}`) }, [active])
  // Pinned tabs are always there, like a browser's.
  const pinKey = pins.join('\n')
  useEffect(() => {
    const missing = pins.filter(id => !openOf(tabsStore.get()).includes(id) && (id === 'settings' || features.some(f => f.id === id && f.Page)))
    if (missing.length) tabsStore.set(s => ({ ...s, open: [...missing, ...openOf(s)] }))
  }, [pinKey])
  // The tab showing scrolls into view when there are more than fit.
  useEffect(() => { strip.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [active, order.length])

  // Ctrl+Tab / Ctrl+Shift+Tab move between the open tabs, in the bar's order.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab') return
      event.preventDefault()
      const now = barOrder(tabsStore.get(), pinsStore.get())
      const index = now.indexOf(tabsStore.get().active)
      activateTab(now[(index + (event.shiftKey ? -1 : 1) + now.length) % now.length])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function drop(target: string) {
    if (dragging && dragging !== target) {
      // Dropped on a tab: it takes that tab's place (pinned and unpinned tabs stay in their own parts).
      const open = openOf(tabsStore.get())
      moveTab(dragging, open.indexOf(target))
    }
    setDragging(null); setOver(null)
  }

  return (
    <header className="tabbar">
      <div className="tabbar-lead">
        <div className="brand-mark" aria-hidden="true" />
        <AppLauncher />
      </div>
      <nav ref={strip} className="tab-strip" role="tablist" aria-label="BridgeDeck tabs">
        {order.map(id => {
          const { title, icon: Icon, badge } = describe(id, dynamic)
          const pinned = pins.includes(id)
          const classes = ['tab', pinned && 'pinned', active === id && 'active', split === id && 'beside', dragging === id && 'dragging', over === id && dragging && dragging !== id && 'drop-here'].filter(Boolean).join(' ')
          return <div key={id} role="tab" aria-selected={active === id} className={classes} title={title} draggable
            onClick={() => activateTab(id)}
            onAuxClick={event => { if (event.button === 1 && !pinned) closeTab(id) }}
            onContextMenu={event => { event.preventDefault(); setMenu({ id, x: event.clientX, y: event.clientY + 4 }) }}
            onDragStart={event => { setDragging(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id) }}
            onDragOver={event => { if (dragging) { event.preventDefault(); setOver(id) } }}
            onDragLeave={() => setOver(o => o === id ? null : o)}
            onDrop={event => { event.preventDefault(); drop(id) }}
            onDragEnd={() => { setDragging(null); setOver(null) }}>
            <Icon size={15} className="tab-icon" />
            {!pinned && <span className="tab-title">{title}</span>}
            {badge && <Badge store={badge} />}
            {split === id && <Columns2 size={12} className="tab-beside" aria-label="On the right of the split screen" />}
            {!pinned && <button className="tab-close" aria-label={`Close ${title}`} title={`Close (${MOD} W)`} onClick={event => { event.stopPropagation(); closeTab(id) }}><X size={13} /></button>}
          </div>
        })}
        <button className="tab-new" onClick={newTab} title={`New tab (${MOD} T)`} aria-label="New tab"><Plus size={16} /></button>
      </nav>
      <div className="tab-actions">
        <button className="icon-button" onClick={() => runShortcut('search')} title={`Search everything (${MOD} K)`} aria-label="Search"><Search size={15} /></button>
        <ChecklistPopup />
        <CalculatorPopup />
        <SystemMeter />
        <CodeChip />
        <SpotifyMini />
        {!hydrated && <span className="save-state">Loading…</span>}
        <button className={chatOpen ? 'icon-button active' : 'icon-button'} onClick={toggleChatPanel} title={`ChatGPT (side panel, ${MOD} J)`} aria-label="ChatGPT"><MessageCircleQuestion size={15} /></button>
        <button className="icon-button" onClick={() => void refreshAll()} title="Refresh everything" aria-label="Refresh"><RefreshCw size={15} /></button>
        <button className={active === 'settings' ? 'icon-button active' : 'icon-button'} onClick={() => activateTab('settings')} title="Settings" aria-label="Settings"><Settings size={15} /></button>
      </div>
      {menu && <TabMenu menu={menu} onClose={() => setMenu(null)} />}
    </header>
  )
}
