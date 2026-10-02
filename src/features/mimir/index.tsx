import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Brain, Download, Play, Square } from 'lucide-react'
import { isTauri, mimirStart, openExternal, mimirStatus, mimirStop, skillPacksInstall, skillPacksStatus, type MimirStatus, type SkillPacksStatus } from '../../lib/bridge'
import { configStore, setConfig, useConfig } from '../../core/config'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle, StatusPill, Toggle } from '../../ui'
import type { FeatureManifest } from '../features'

/** Mimir's process as BridgeDeck runs it (see src-tauri/src/mimir_host.rs). */
export const mimirStore = createStore<MimirStatus>({ phase: 'stopped', detail: '', url: null, log: [], available: false })

/** The tab's iframe, for handing it the voice hotkey. */
let frame: HTMLIFrameElement | null = null

/** What the tab says while Mimir isn't on screen yet. */
export function phaseText(status: MimirStatus, enabled: boolean) {
  if (!status.available) return 'Mimir isn’t in this BridgeDeck’s source folder (mimir/).'
  if (!enabled) return 'Mimir is your assistant with a face and a voice, and it can improve its own code. Set it up to run it inside BridgeDeck.'
  if (status.phase === 'failed') return status.detail || 'Mimir couldn’t start.'
  if (status.phase === 'stopped') return 'Mimir is stopped.'
  return status.detail || 'Starting Mimir…'
}

async function refresh() {
  if (isTauri()) mimirStore.set(await mimirStatus())
}

async function start() {
  try { mimirStore.set(await mimirStart()) } catch { /* shown by the next status */ }
}

/** Starts Mimir with BridgeDeck once it's set up, and hands it the voice hotkey (⌘/Ctrl+Shift+Space). */
function MimirBackground() {
  const enabled = useStore(configStore).mimir.enabled
  useEffect(() => { if (isTauri() && enabled) void start() }, [enabled])
  usePeriodicRefresh(refresh, 2000, [])
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let closed = false
    void listen('mimir-voice-hotkey', () => {
      activateTab('mimir')
      const url = mimirStore.get().url
      // Give a just-shown tab a moment to lay out before the page starts listening.
      if (url) window.setTimeout(() => frame?.contentWindow?.postMessage({ source: 'bridgedeck', type: 'voice-hotkey' }, new URL(url).origin), 150)
    }).then(fn => { if (closed) fn(); else unlisten = fn })
    return () => { closed = true; unlisten?.() }
  }, [])
  return null
}

function MimirPage() {
  const config = useConfig()
  const status = useStore(mimirStore)
  const ref = useRef<HTMLIFrameElement>(null)
  useEffect(() => { frame = ref.current; return () => { frame = null } })
  const enabled = config.mimir.enabled

  if (enabled && status.phase === 'running' && status.url) {
    return <div className="mimir-session">
      <iframe ref={ref} className="mimir-frame" title="Mimir" src={status.url} allow="microphone; camera; autoplay; clipboard-read; clipboard-write" />
    </div>
  }
  const busy = status.phase === 'setup' || status.phase === 'starting'
  return <Card><SectionTitle title="Mimir" subtitle={phaseText(status, enabled)} action={<StatusPill online={status.phase === 'running'} label={busy ? 'Starting' : status.phase === 'failed' ? 'Problem' : enabled ? 'Stopped' : 'Not set up'} />} />
    <div className="actions">
      {!enabled && <button disabled={!status.available} onClick={() => setConfig(c => ({ ...c, mimir: { ...c.mimir, enabled: true } }))}><Brain size={16}/>Set up Mimir</button>}
      {enabled && !busy && <button onClick={() => void start()}><Play size={16}/>{status.phase === 'failed' ? 'Try again' : 'Start'}</button>}
    </div>
    {!enabled && <p className="vendor-note">Setting up installs Mimir’s packages and builds it (a few minutes, once). It needs Node.js, which BridgeDeck’s own setup already installed.</p>}
    {enabled && !!status.log.length && <pre className="mimir-log">{status.log.join('\n')}</pre>}
  </Card>
}

function MimirSettings() {
  const config = useConfig()
  const status = useStore(mimirStore)
  return <Card><SectionTitle title="Mimir" subtitle={status.phase === 'running' ? 'Running inside BridgeDeck' : phaseText(status, config.mimir.enabled)} />
    <Toggle checked={config.mimir.enabled} onChange={enabled => { setConfig(c => ({ ...c, mimir: { ...c.mimir, enabled } })); if (!enabled) void mimirStop().then(mimirStore.set).catch(() => undefined) }} label="Run Mimir with BridgeDeck" />
    {status.phase === 'running' && <div className="actions"><button className="secondary" onClick={() => void mimirStop().then(mimirStore.set).catch(() => undefined)}><Square size={15}/>Stop until next start</button></div>}
    <p className="hint">Mimir’s brain, voice and persona settings are in the Mimir tab (⚙). Its voice shortcut is {navigator.userAgent.includes('Mac') ? '⌘⇧Space' : 'Ctrl+Shift+Space'} while it runs.</p>
    <SkillPacks />
  </Card>
}

/** Expert skill packs (SKILL.md format) Mimir can follow; downloaded at a pinned version. */
function SkillPacks() {
  const [status, setStatus] = useState<SkillPacksStatus | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!isTauri()) return
    void skillPacksStatus().then(s => { setStatus(s); setChosen(new Set(s.packs.filter(p => p.installed).map(p => p.id))) }).catch(e => setError(String(e)))
  }, [])
  if (!status) return error ? <p className="notes-error">{error}</p> : null
  const installed = new Set(status.packs.filter(p => p.installed).map(p => p.id))
  const changed = status.outdated || chosen.size !== installed.size || [...chosen].some(id => !installed.has(id))
  async function apply() {
    setBusy(true); setError('')
    try {
      const next = await skillPacksInstall([...chosen])
      setStatus(next)
      setChosen(new Set(next.packs.filter(p => p.installed).map(p => p.id)))
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const skills = status.packs.filter(p => chosen.has(p.id)).reduce((n, p) => n + p.skills, 0)
  return <div className="settings-block skill-packs">
    <h3>Skill packs</h3>
    <p className="hint">Step-by-step methods Mimir follows when a task matches one, from <a href={`https://github.com/${status.source}`} onClick={e => { e.preventDefault(); void openExternal(`https://github.com/${status.source}`) }}>{status.source}</a> (MIT), version {status.commit.slice(0, 7)}. Their scripts run in Mimir’s sandbox, with no access to your files.</p>
    <div className="skill-pack-list">{status.packs.map(p => <label key={p.id} className="skill-pack">
      <input type="checkbox" checked={chosen.has(p.id)} onChange={e => setChosen(s => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n })} />
      <span className="grow"><strong>{p.title}</strong><small>{p.description}</small></span><small>{p.skills} skills{p.installed ? ' · installed' : ''}</small>
    </label>)}</div>
    <div className="actions">
      <button disabled={busy || !changed} onClick={() => void apply()}><Download size={15} />{busy ? 'Downloading…' : chosen.size ? `Install ${chosen.size} pack${chosen.size === 1 ? '' : 's'} (${skills} skills)` : 'Remove all packs'}</button>
    </div>
    {status.outdated && <p className="hint">These packs are from an older version; installing again updates them.</p>}
    {error && <p className="notes-error">{error}</p>}
  </div>
}

export const mimir: FeatureManifest = { id: 'mimir', title: 'Mimir', icon: Brain, Page: MimirPage, keepAlive: true, Background: MimirBackground, Settings: MimirSettings, settingsOrder: 45 }
