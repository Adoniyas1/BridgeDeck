import WebFullscreen from './WebFullscreen'
import ChatPanel from './ChatPanel'
import { Palette, ShortcutKeys, ShortcutsHelp } from './Palette'
import { useEffect, useRef, useState, Suspense, type PointerEvent as ReactPointerEvent } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import TabErrorBoundary from './TabErrorBoundary'
import { BridgeLinkBackground, sourceUpdateStore } from '../core/bridgelink'
import { hydrateConfig, hydratedStore } from '../core/config'
import { noticeStore, setNotice } from '../core/notice'
import { useStore } from '../core/store'
import { closeTab, openTab, tabsStore, unsplit, type DynamicTab } from '../core/tabs'
import { Card, SectionTitle } from '../ui'
import { features } from '../features/registry'
import { TabAwake } from '../core/awake'
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

/** Pages that use the whole area under the tab bar, with no margins. */
const FILL_PAGES = new Set(['browser', 'tv', 'logic', 'code', 'spotify', 'mail'])
const SPLIT_KEY = 'bd-split-left'

/** Where a visible tab sits: alone, or on the left or right of a split. */
type Side = 'only' | 'left' | 'right' | null
const sideClass = (side: Side, fill: boolean) => side === 'left' || side === 'right' ? `tab-panel split-pane pane-${side}${fill ? ' pane-fill' : ''}` : 'tab-panel'

function DynamicTabView({ tab, side }: { tab: DynamicTab; side: Side }) {
  const View = features.map(feature => feature.tabKinds?.[tab.kind]).find(Boolean)
  return <div className={sideClass(side, FILL_KINDS.has(tab.kind))} hidden={!side}><TabErrorBoundary name={tab.kind}><TabAwake active={!!side}><Suspense fallback={<Loading />}>{View ? <View tab={tab} active={!!side} /> : <UnknownTab tab={tab} />}</Suspense></TabAwake></TabErrorBoundary></div>
}

/** The bar between the two sides of a split: drag to resize (remembered), double-click for half
 *  and half, × to end the split. */
function SplitDivider({ onRatio }: { onRatio: (ratio: number) => void }) {
  const dragging = useRef(false)
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const main = event.currentTarget.parentElement?.getBoundingClientRect()
    if (main?.width) onRatio(Math.min(0.8, Math.max(0.2, (event.clientX - main.left) / main.width)))
  }
  return <div className="split-divider" role="separator" aria-orientation="vertical" title="Drag to resize · double-click for half and half"
    onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
    onPointerMove={move} onPointerUp={() => { dragging.current = false }} onDoubleClick={() => onRatio(0.5)}>
    <button className="split-close" title="Close split screen" aria-label="Close split screen" onPointerDown={e => e.stopPropagation()} onClick={unsplit}>×</button>
  </div>
}

export default function App() {
  const hydrated = useStore(hydratedStore)
  const { active, dynamic, split: splitId } = useStore(tabsStore)
  const isFill = (id: string) => FILL_PAGES.has(id) || dynamic.some(tab => tab.id === id && FILL_KINDS.has(tab.kind))
  // A split shows only while its tab is open (a page id, Settings, or an open dynamic tab).
  const split = splitId && splitId !== active && (splitId === 'settings' || features.some(f => f.id === splitId && f.Page) || dynamic.some(t => t.id === splitId)) ? splitId : null
  const side = (id: string): Side => id === active ? (split ? 'left' : 'only') : id === split ? 'right' : null
  const [ratio, setRatio] = useState(() => { try { return Number(localStorage.getItem(SPLIT_KEY)) || 0.5 } catch { return 0.5 } })
  const saveRatio = (r: number) => { setRatio(r); try { localStorage.setItem(SPLIT_KEY, String(r)) } catch { /* only for this run */ } }
  const notice = useStore(noticeStore)
  const sourceUpdate = useStore(sourceUpdateStore)
  // Closing the rebuild notice hides it until the source changes again.
  const [hiddenSourceAt, setHiddenSourceAt] = useState(() => { try { return localStorage.getItem(HIDDEN_SOURCE_KEY) ?? '' } catch { return '' } })
  const hideSourceUpdate = (at: string) => { setHiddenSourceAt(at); try { localStorage.setItem(HIDDEN_SOURCE_KEY, at) } catch { /* only for this run */ } }

  useEffect(() => { void hydrateConfig() }, [])
  // The browser and books use the whole window under the tab bar, with no page margins.
  // Kept-alive tabs mount when first opened (their code isn't loaded at start-up), then stay.
  const [visited, setVisited] = useState<Set<string>>(() => new Set([active]))
  useEffect(() => { setVisited(v => [active, split].every(id => !id || v.has(id)) ? v : new Set([...v, active, ...(split ? [split] : [])])) }, [active, split])
  const fill = !!split || isFill(active)

  return (
    <div className="shell">
      <TabBar />
      <WebFullscreen />
      <ShortcutKeys />
      {hydrated && <><Palette /><ShortcutsHelp /></>}
      <div className="shell-body">
      <main className={split ? 'fill split' : fill ? 'fill' : undefined} style={split ? { gridTemplateColumns: `minmax(240px, ${ratio * 100}%) 8px minmax(240px, 1fr)` } : undefined}>
        {hydrated && <UpdateBanner />}
        {notice && <div className="notice"><Activity size={15}/><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
        {sourceUpdate?.rebuildNeeded && String(sourceUpdate.newestSourceAt) !== hiddenSourceAt && <div className="notice"><RefreshCw size={15}/><span>BridgeDeck source changed since this build (newest: {sourceUpdate.newestSourceFile}, {new Date(sourceUpdate.newestSourceAt).toLocaleString()}). Rebuild to pick up the synced changes; ask Claude or Codex to run the build here.</span><button title="Hide until the source changes again" onClick={() => hideSourceUpdate(String(sourceUpdate.newestSourceAt))}>×</button></div>}

        {hydrated && <>
          <BridgeLinkBackground />
          {features.map(({ id, Background }) => Background && <Background key={id} />)}
        </>}

        {/* Every tab stays loaded once opened (switching back finds it as it was); hidden for over a
            minute, its refreshes pause (core/awake.ts). */}
        {features.map(({ id, Page, keepAlive, mountAtStart }) => Page && (side(id) || visited.has(id) || (keepAlive && mountAtStart)) &&
          <div key={id} className={sideClass(side(id), isFill(id))} hidden={!side(id)}><TabErrorBoundary name={id}><TabAwake active={!!side(id)}><Suspense fallback={<Loading />}><Page active={!!side(id)} /></Suspense></TabAwake></TabErrorBoundary></div>)}
        {side('settings') && <div className={sideClass(side('settings'), false)}><TabErrorBoundary name="settings"><SettingsPage /></TabErrorBoundary></div>}
        {dynamic.map(tab => <DynamicTabView key={tab.id} tab={tab} side={side(tab.id)} />)}
        {split && <SplitDivider onRatio={saveRatio} />}
      </main>
      <ChatPanel />
      </div>
    </div>
  )
}
