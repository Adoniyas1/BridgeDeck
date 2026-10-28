import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { ProblemReport } from './ProblemReport'
import { FeatureCheck } from './FeatureCheck'
import { Activity, Bell, CheckCircle2, Info, Search, Settings2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { defaultConfig } from '../lib/config'
import { setConfig } from '../core/config'
import { activateTab, TAB_ALIASES } from '../core/tabs'
import { refreshAll } from '../core/refresh'
import { Card, SectionTitle } from '../ui'
import { features } from '../features/registry'
import { GROUPS, groupOf } from '../features/groups'
import { version } from '../../package.json'
import NotificationSettings from './NotificationSettings'
import DiagnosticsButton from './DiagnosticsButton'
import ErrorLogCard from './ErrorLogCard'
import ActivitySettings from './ActivitySettings'
import { settingsSectionStore } from '../core/settingsNav'
import { useStore } from '../core/store'

type Section = { id: string; title: string; icon: LucideIcon; group: string; Body: ComponentType }

/** Settings sections take their feature's name, except where the feature's settings cover more. */
const TITLES: Record<string, string> = { computers: 'Computers & updates', sync: 'Synced folders', home: 'Home & briefs', browser: 'Web pages', mimir: 'AI' }
const SELECTED_KEY = 'bridgedeck.settingsSection'

function About() {
  return <>
    <ProblemReport />
    <FeatureCheck />
    <ErrorLogCard />
    <Card><SectionTitle title={`BridgeDeck ${version}`} subtitle="Settings are saved in BridgeDeck's app-config folder; passwords, tokens and API keys are kept in the system keychain (macOS Keychain or Windows Credential Manager)." />
      <div className="actions">
        <button className="secondary" onClick={() => void refreshAll()}><CheckCircle2 size={16}/>Recheck integrations</button>
        <DiagnosticsButton />
        <button className="secondary" onClick={() => { setConfig(c => ({ ...c, setup: { ...c.setup, dismissed: false } })); activateTab('home') }}>Show setup checklist</button>
        <button className="secondary" onClick={() => { if (window.confirm('Reset every setting to its default? Your notes, files and pairings are kept.')) setConfig(structuredClone(defaultConfig)) }}><Settings2 size={16}/>Reset defaults</button>
      </div>
    </Card>
  </>
}

/** Settings like the Mac's System Settings: sections down the left (grouped like the tabs), one shown
 *  at a time, and a search that finds a setting by any words in it. */
export default function SettingsPage() {
  const sections = useMemo<Section[]>(() => {
    const own = features.filter(f => f.Settings).map(f => ({
      id: f.id, title: TITLES[f.id] ?? f.title, icon: f.icon, Body: f.Settings as ComponentType,
      group: groupOf(TAB_ALIASES[f.id] ?? f.id)?.title ?? 'General', order: f.settingsOrder ?? 100,
    }))
    const groupIndex = (title: string) => { const i = GROUPS.findIndex(g => g.title === title); return i < 0 ? GROUPS.length : i }
    own.sort((a, b) => groupIndex(a.group) - groupIndex(b.group) || a.order - b.order)
    return [...own, { id: 'notifications', title: 'Notifications', icon: Bell, group: 'App', Body: NotificationSettings }, { id: 'activity', title: 'Activity & safety', icon: Activity, group: 'App', Body: ActivitySettings }, { id: 'about', title: 'About & diagnostics', icon: Info, group: 'App', Body: About }]
  }, [])
  const [selected, setSelected] = useState(() => { try { return localStorage.getItem(SELECTED_KEY) ?? sections[0].id } catch { return sections[0].id } })
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const bodies = useRef<Record<string, HTMLDivElement | null>>({})

  // Search reads what each section shows (every label and hint), so any word on it finds it.
  useLayoutEffect(() => {
    const q = query.trim().toLowerCase()
    if (!q) { setMatches(null); return }
    setMatches(new Set(sections.filter(s => `${s.title} ${bodies.current[s.id]?.textContent ?? ''}`.toLowerCase().includes(q)).map(s => s.id)))
  }, [query, sections])

  const pick = (id: string) => { setSelected(id); setQuery(''); try { localStorage.setItem(SELECTED_KEY, id) } catch { /* this run only */ } }
  const asked = useStore(settingsSectionStore)
  useEffect(() => { if (asked) { pick(asked); settingsSectionStore.set(null) } }, [asked])
  const current = sections.some(s => s.id === selected) ? selected : sections[0].id
  const shown = (id: string) => matches ? matches.has(id) : id === current
  let lastGroup = ''

  return <div className="settings-layout">
    <nav className="settings-nav" aria-label="Settings sections">
      <label className="settings-search"><Search size={14} /><input placeholder="Search settings" value={query} onChange={e => setQuery(e.target.value)} /></label>
      {sections.map(({ id, title, icon: Icon, group }) => {
        const heading = group !== lastGroup ? group : null
        lastGroup = group
        return <div key={id}>
          {heading && <div className="settings-nav__group">{heading}</div>}
          <button className={`settings-nav__item${!matches && id === current ? ' active' : ''}${matches && !matches.has(id) ? ' dim' : ''}`} onClick={() => pick(id)}><Icon size={15} /><span>{title}</span></button>
        </div>
      })}
    </nav>
    <div className="settings-content">
      {matches && <p className="hint">{matches.size ? `${matches.size} section${matches.size === 1 ? '' : 's'} mention “${query.trim()}”` : `Nothing mentions “${query.trim()}”.`}</p>}
      {sections.map(({ id, title, Body }) => <div key={id} ref={el => { bodies.current[id] = el }} hidden={!shown(id)} className="settings-section">
        {(matches || id === current) && <h1 className="settings-section__title">{title}</h1>}
        <div className="settings-stack"><Body /></div>
      </div>)}
    </div>
  </div>
}
