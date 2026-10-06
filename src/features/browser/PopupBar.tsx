import { ShieldX, X } from 'lucide-react'
import { setConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { siteOf } from './model'
import { dismissPopups, openInNewTab, popupsStore } from './state'

/** "Blocked a pop-up": under the Browser and TV bars, with "open it" and "always allow here". */
export default function PopupBar({ tab }: { tab: string }) {
  const popups = useStore(popupsStore).filter(p => p.tab === tab)
  if (!popups.length) return null
  const latest = popups[0]
  const opener = latest.opener.replace(/^www\./, '')
  const allow = () => {
    setConfig(c => ({ ...c, browsing: { ...c.browsing, popupSites: [...c.browsing.popupSites.filter(s => s !== opener), opener] } }))
    dismissPopups(tab)
  }
  return <div className="popup-bar" role="status">
    <ShieldX size={14} />
    <span className="grow">Blocked {popups.length > 1 ? `${popups.length} pop-ups` : 'a pop-up'} to <strong>{siteOf(latest.url) || latest.url}</strong></span>
    <button className="ghost" onClick={() => { openInNewTab(latest.url); dismissPopups(tab) }}>Open it</button>
    {opener && <button className="ghost" title={`Pop-ups from ${opener} open without asking`} onClick={allow}>Always allow on {opener}</button>}
    <button className="ghost" title="Hide" onClick={() => dismissPopups(tab)}><X size={12} /></button>
  </div>
}
