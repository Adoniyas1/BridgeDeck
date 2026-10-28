import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}

export function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return <label className="toggle-row"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span>{label}</span></label>
}

export function StatusPill({ online, label }: { online: boolean; label?: string }) {
  return <span className={online ? 'status-pill online' : 'status-pill offline'}><i />{label ?? (online ? 'Online' : 'Offline')}</span>
}

export type MenuItem = { label: string; icon?: ReactNode; onClick: () => void; title?: string; danger?: boolean; disabled?: boolean }

/** A ⋯ button with the less-used actions in a list under it; closes on a choice, a click outside or Escape. */
export function MoreMenu({ items, title = 'More', align = 'right' }: { items: Array<MenuItem | null | false | undefined>; title?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key) }
  }, [open])
  const shown = items.filter((i): i is MenuItem => !!i)
  return <div className="more-menu" ref={box}>
    <button type="button" className="secondary more-menu-button" title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}><MoreHorizontal size={15} /></button>
    {open && <div className={`more-menu-list ${align}`} role="menu">
      {shown.map(i => <button key={i.label} type="button" role="menuitem" className={i.danger ? 'more-menu-item danger-item' : 'more-menu-item'} title={i.title} disabled={i.disabled} onClick={() => { setOpen(false); i.onClick() }}>{i.icon}<span>{i.label}</span></button>)}
    </div>}
  </div>
}
