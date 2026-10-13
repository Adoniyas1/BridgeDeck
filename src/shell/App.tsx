import WebFullscreen from './WebFullscreen'
import ChatPanel from './ChatPanel'
import { Palette, ShortcutKeys, ShortcutsHelp } from './Palette'
import { useEffect, useState, Suspense } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import TabErrorBoundary from './TabErrorBoundary'
import { BridgeLinkBackground, sourceUpdateStore } from '../core/bridgelink'
import { hydrateConfig, hydratedStore } from '../core/config'
import { noticeStore, setNotice } from '../core/notice'
import { useStore } from '../core/store'
import { closeTab, openTab, tabsStore, type DynamicTab } from '../core/tabs'
import { Card, SectionTitle } from '../ui'
import { features } from '../features/registry'
import { UpdateBanner } from '../features/devices/updates'
import SettingsPage from './SettingsPage'
import TabBar from './TabBar'

// Dev builds expose the tab API for manual and automated testing of dynamic tabs.
if (import.meta.env.DEV) Object.assign(window, { bridgedeck: { openTab, closeTab, tabsStore } })

function UnknownTab({ tab }: { tab: DynamicTab }) {
  return <Card><SectionTitle title={tab.title} subtitle={`This build has no view for "${tab.kind}" tabs.`} /><div className="bb-placeholder">Close this tab, or update BridgeDeck.</div></Card>
}

const FILL_KINDS = new Set(['study-book', 'web'])
const HIDDEN_SOURCE_KEY = 'bridgedeck.hiddenSourceUpdate'

/** Shown for the moment a tab's code is loading (each tab's code loads when first opened). */
function Loading() {
  return <p className="hint tab-loading">Loading…</p>
}

function DynamicTabView({ tab, active }: { tab: DynamicTab; active: boolean }) {
  const View = features.map(feature => feature.tabKinds?.[tab.kind]).find(Boolean)
  return <div className="tab-panel" hidden={!active}><TabErrorBoundary name={tab.kind}><Suspense fallback={<Loading />}>{View ? <View tab={tab} active={active} /> : <UnknownTab tab={tab} />}</Suspense></TabErrorBoundary></div>
}

export default function App() {
  const hydrated = useStore(hydratedStore)
  const { active, dynamic } = useStore(tabsStore)
  const notice = useStore(noticeStore)
  const sourceUpdate = useStore(sourceUpdateStore)
  // Closing the rebuild notice hides it until the source changes again.
  const [hiddenSourceAt, setHiddenSourceAt] = useState(() => { try { return localStorage.getItem(HIDDEN_SOURCE_KEY) ?? '' } catch { return '' } })
  const hideSourceUpdate = (at: string) => { setHiddenSourceAt(at); try { localStorage.setItem(HIDDEN_SOURCE_KEY, at) } catch { /* only for this run */ } }

  useEffect(() => { void hydrateConfig() }, [])
  // The browser and books use the whole window under the tab bar, with no page margins.
  // Kept-alive tabs mount when first opened (their code isn't loaded at start-up), then stay.
  const [visited, setVisited] = useState<Set<string>>(() => new Set([active]))
  useEffect(() => { setVisited(v => v.has(active) ? v : new Set(v).add(active)) }, [active])
  const fill = active === 'browser' || active === 'tv' || active === 'logic' || active === 'spotify' || active === 'mail' || dynamic.some(tab => tab.id === active && FILL_KINDS.has(tab.kind))

  return (
    <div className="shell">
      <TabBar />
      <WebFullscreen />
      <ShortcutKeys />
      {hydrated && <><Palette /><ShortcutsHelp /></>}
      <div className="shell-body">
      <main className={fill ? 'fill' : undefined}>
        {hydrated && <UpdateBanner />}
        {notice && <div className="notice"><Activity size={15}/><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
        {sourceUpdate?.rebuildNeeded && String(sourceUpdate.newestSourceAt) !== hiddenSourceAt && <div className="notice"><RefreshCw size={15}/><span>BridgeDeck source changed since this build (newest: {sourceUpdate.newestSourceFile}, {new Date(sourceUpdate.newestSourceAt).toLocaleString()}). Rebuild to pick up the synced changes; ask Claude or Codex to run the build here.</span><button title="Hide until the source changes again" onClick={() => hideSourceUpdate(String(sourceUpdate.newestSourceAt))}>×</button></div>}

        {hydrated && <>
          <BridgeLinkBackground />
          {features.map(({ id, Background }) => Background && <Background key={id} />)}
        </>}

        {features.map(({ id, Page, keepAlive, mountAtStart }) => Page && (active === id || (keepAlive && (mountAtStart || visited.has(id)))) &&
          <div key={id} className="tab-panel" hidden={active !== id}><TabErrorBoundary name={id}><Suspense fallback={<Loading />}><Page active={active === id} /></Suspense></TabErrorBoundary></div>)}
        {active === 'settings' && <div className="tab-panel"><TabErrorBoundary name="settings"><SettingsPage /></TabErrorBoundary></div>}
        {dynamic.map(tab => <DynamicTabView key={tab.id} tab={tab} active={active === tab.id} />)}
      </main>
      <ChatPanel />
      </div>
    </div>
  )
}
