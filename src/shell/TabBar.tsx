import { useEffect } from 'react'
import { AppWindow, MessageCircleQuestion, RefreshCw, Settings, X } from 'lucide-react'
import { chatPanelStore, toggleChatPanel } from '../core/chatgpt'
import { hydratedStore } from '../core/config'
import { refreshAll } from '../core/refresh'
import { useStore, type Store } from '../core/store'
import { activateTab, closeTab, tabsStore } from '../core/tabs'
import { features } from '../features/registry'

const fixed = features.filter(feature => feature.Page)
const iconFor = (kind: string) => features.find(feature => feature.tabKinds?.[kind])?.icon ?? AppWindow

function Badge({ store }: { store: Store<number> }) {
  const count = useStore(store)
  if (!count) return null
  return <em className="tab-badge" aria-label={`${count} unread`}>{count > 99 ? '99+' : count}</em>
}

/** Chrome-style tab strip: the features' fixed tabs, then closable dynamic tabs, then Settings. */
export default function TabBar() {
  const { active, dynamic } = useStore(tabsStore)
  const hydrated = useStore(hydratedStore)
  const chatOpen = useStore(chatPanelStore).open

  // Ctrl+Tab / Ctrl+Shift+Tab move between tabs, like a browser.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab') return
      event.preventDefault()
      const order = [...fixed.map(feature => feature.id), ...tabsStore.get().dynamic.map(tab => tab.id), 'settings']
      const index = order.indexOf(tabsStore.get().active)
      activateTab(order[(index + (event.shiftKey ? -1 : 1) + order.length) % order.length])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header className="tabbar">
      <div className="brand-mark" aria-hidden="true" />
      <nav className="tab-strip" role="tablist" aria-label="BridgeDeck tabs">
        {fixed.map(({ id, title, icon: Icon, badge }) => (
          <button key={id} role="tab" aria-selected={active === id} className={active === id ? 'tab active' : 'tab'} onClick={() => activateTab(id)} title={title}>
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
        {!hydrated && <span className="save-state">Loading…</span>}
        <button className={chatOpen ? 'icon-button active' : 'icon-button'} onClick={toggleChatPanel} title="ChatGPT (side panel)" aria-label="ChatGPT"><MessageCircleQuestion size={15} /></button>
        <button className="icon-button" onClick={() => void refreshAll()} title="Refresh"><RefreshCw size={15} /></button>
        <button className={active === 'settings' ? 'icon-button active' : 'icon-button'} onClick={() => activateTab('settings')} title="Settings" aria-label="Settings"><Settings size={15} /></button>
      </div>
    </header>
  )
}
