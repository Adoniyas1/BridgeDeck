import { Bot, Computer, Files, FolderSync, Home, MessageSquare, MonitorUp, ServerCog, Settings } from 'lucide-react'
import type { PageKey } from '../types'

const items: Array<{ key: PageKey; label: string; icon: typeof Home }> = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'computers', label: 'Computers', icon: Computer },
  { key: 'remote', label: 'Remote', icon: MonitorUp },
  { key: 'messages', label: 'Messages', icon: MessageSquare },
  { key: 'ai', label: 'AI Center', icon: Bot },
  { key: 'files', label: 'Files', icon: Files },
  { key: 'sync', label: 'Sync', icon: FolderSync },
  { key: 'services', label: 'Services', icon: ServerCog },
  { key: 'settings', label: 'Settings', icon: Settings },
]

export default function Sidebar({ page, setPage, badges = {} }: { page: PageKey; setPage: (page: PageKey) => void; badges?: Partial<Record<PageKey, number>> }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true" />
        <div><strong>BridgeDeck</strong></div>
      </div>
      <nav>
        {items.map(({ key, label, icon: Icon }) => (
          <button key={key} className={page === key ? 'nav-item active' : 'nav-item'} onClick={() => setPage(key)}>
            <Icon size={18} /> <span>{label}</span>
            {!!badges[key] && <em className="nav-badge" aria-label={`${badges[key]} unread`}>{badges[key]! > 99 ? '99+' : badges[key]}</em>}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">v0.7</div>
    </aside>
  )
}
