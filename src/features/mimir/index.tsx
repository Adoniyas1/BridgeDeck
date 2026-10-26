import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Bot, Brain, Download, MessageCircleQuestion, Orbit, Play, Settings2, Square } from 'lucide-react'
import { isTauri, mimirStart, openExternal, mimirStatus, mimirStop, skillPacksInstall, skillPacksStatus, mimirActivity, type MimirActivity, type MimirStatus, type SkillPacksStatus } from '../../lib/bridge'
import { configStore, setConfig, useConfig } from '../../core/config'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { activateTab, splitTab, tabsStore } from '../../core/tabs'
import { workContext } from '../../core/tabContext'
import { aiAllowed, examStore } from '../../core/exam'
import { jarvisRequestStore, MOD } from '../../core/shortcuts'
import { openSettings } from '../../core/settingsNav'
import { toggleChatPanel } from '../../core/chatgpt'
import { Card, SectionTitle, Toggle } from '../../ui'
import { AiCheckup, MimirBrain, ModelLibrary } from './Brain'
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
  const jarvis = useStore(jarvisRequestStore)
  useEffect(() => { if (jarvis) void openJarvis() }, [jarvis])
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

// Mimir's page asks BridgeDeck for things: what's open (the last tab worked in) to attach to a
// message, or its AI settings (model downloads live there).
if (typeof window !== 'undefined') window.addEventListener('message', event => {
  const data = event.data as { source?: string; type?: string; id?: unknown } | null
  if (data?.source !== 'mimir' || !frame?.contentWindow || event.source !== frame.contentWindow) return
  if (data.type === 'open-settings') { openSettings('mimir'); return }
  if (data.type !== 'context-request') return
  const url = mimirStore.get().url
  if (!url) return
  frame.contentWindow.postMessage({ source: 'bridgedeck', type: 'context', id: data.id, context: workContext() }, new URL(url).origin)
})

/** Opens the Mimir tab and asks it `text` (started first if it isn't running). The page needs a
 *  moment after it appears before it listens, so the question is sent once it's there. With
 *  `beside`, Mimir opens on the right of a split screen, so what's being asked about stays in view. */
export async function askMimir(text: string, beside = false, course?: string) {
  if (!aiAllowed(course)) return
  if (beside && tabsStore.get().active !== 'mimir') splitTab('mimir')
  else activateTab('mimir')
  await postWhenReady({ source: 'bridgedeck', type: 'ask', text })
}

/** Opens the Mimir tab with its own settings (voice, persona, the team's roles). */
export async function openMimirSettings() {
  activateTab('mimir')
  await postWhenReady({ source: 'bridgedeck', type: 'settings' })
}

/** Opens the Mimir tab in Jarvis's Talk view (the orb and captions, for voice). */
export async function openJarvis() {
  if (!aiAllowed()) return
  activateTab('mimir')
  await postWhenReady({ source: 'bridgedeck', type: 'jarvis' })
}

/** Starts Mimir if needed and hands its page `message` once it's loaded and listening. */
async function postWhenReady(message: Record<string, unknown>) {
  if (!mimirStore.get().url && isTauri()) {
    setConfig(c => ({ ...c, mimir: { ...c.mimir, enabled: true } }))
    await mimirStart().then(mimirStore.set).catch(() => undefined)
  }
  const deadline = Date.now() + 60_000
  let seen = 0
  const post = () => {
    const url = mimirStore.get().url
    if (frame?.contentWindow && url) {
      // Wait a little after the frame first shows up, for its page to load.
      if (!seen) seen = Date.now()
      if (Date.now() - seen > 1500) { frame.contentWindow.postMessage(message, new URL(url).origin); return }
    }
    if (Date.now() < deadline) window.setTimeout(post, 400)
  }
  window.setTimeout(post, 300)
}

function MimirPage() {
  const config = useConfig()
  const status = useStore(mimirStore)
  const exam = useStore(examStore)
  const ref = useRef<HTMLIFrameElement>(null)
  useEffect(() => { frame = ref.current; return () => { frame = null } })
  const enabled = config.mimir.enabled
  if (exam && exam.until > Date.now()) return <Card><SectionTitle title="Mimir is off during exam mode" subtitle={`${exam.course ? `${exam.course} · ` : ''}until ${new Date(exam.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. It comes back by itself when exam mode ends.`} /></Card>

  if (enabled && status.phase === 'running' && status.url) {
    return <div className="mimir-session">
      <iframe ref={ref} className="mimir-frame" title="Mimir" src={status.url} allow="microphone; camera; autoplay; clipboard-read; clipboard-write" />
    </div>
  }
  const busy = status.phase === 'setup' || status.phase === 'starting'
  const tone = status.phase === 'failed' ? 'error' : busy ? 'busy' : 'idle'
  return <div className={`mimir-launch mimir-launch--${tone}`}>
    <div className="mimir-launch__backdrop" aria-hidden="true" />
    <div className="mimir-launch__panel">
      <div className="mimir-launch__core" aria-hidden="true"><i /><i /><i /><b /></div>
      <span className="mimir-launch__eyebrow">MIMIR</span>
      <h2>{busy ? (status.phase === 'setup' ? 'Setting up Mimir' : 'Waking Mimir') : status.phase === 'failed' ? 'Mimir couldn’t start' : enabled ? 'Mimir is asleep' : 'Your assistant, with a voice'}</h2>
      <p>{phaseText(status, enabled)}</p>
      <div className="actions">
        {!enabled && <button disabled={!status.available} onClick={() => setConfig(c => ({ ...c, mimir: { ...c.mimir, enabled: true } }))}><Brain size={16}/>Set up Mimir</button>}
        {enabled && !busy && <button onClick={() => void start()}><Play size={16}/>{status.phase === 'failed' ? 'Try again' : 'Start'}</button>}
      </div>
      {!enabled && <p className="mimir-launch__note">Setting up installs Mimir’s packages and builds it (a few minutes, once). It needs Node.js, which BridgeDeck’s own setup already installed.</p>}
      {enabled && !!status.log.length && <pre className="mimir-log">{status.log.join('\n')}</pre>}
    </div>
  </div>
}

/** Settings → AI: every AI part of BridgeDeck in one place. Mimir (with Jarvis, its brain and models),
 *  the ChatGPT side panel (kept separate: your own chatgpt.com account), and outside agents. */
function MimirSettings() {
  const config = useConfig()
  const status = useStore(mimirStore)
  const running = status.phase === 'running'
  return <Card><SectionTitle title="Mimir" subtitle={running ? 'Your assistant, running inside BridgeDeck' : phaseText(status, config.mimir.enabled)} />
    <Toggle checked={config.mimir.enabled} onChange={enabled => { setConfig(c => ({ ...c, mimir: { ...c.mimir, enabled } })); if (!enabled) void mimirStop().then(mimirStore.set).catch(() => undefined) }} label="Run Mimir with BridgeDeck" />
    <div className="actions">
      <button disabled={!config.mimir.enabled} onClick={() => void openJarvis()} title={`${MOD} Shift J`}><Orbit size={15}/>Open Jarvis</button>
      <button className="secondary" disabled={!running} onClick={() => void openMimirSettings()} title="Voice, persona, the team's roles and model servers"><Settings2 size={15}/>Voice, persona and team</button>
      {running && <button className="secondary" onClick={() => void mimirStop().then(mimirStore.set).catch(() => undefined)}><Square size={15}/>Stop until next start</button>}
    </div>
    <p className="hint">Mimir opens as Jarvis: Talk for voice, Chat for the whole conversation ({MOD} J inside Mimir switches them). {MOD} Shift J from anywhere in BridgeDeck brings it up in Talk; its voice shortcut is {navigator.userAgent.includes('Mac') ? '⌘⇧Space' : 'Ctrl+Shift+Space'}. “Ask Mimir” in Study, Code and Notes opens it beside what you’re working on, and it can see that tab, your notes, calendar and courses. Its memory is the notes “Mimir’s memory” and “About you (Mimir)”.</p>
    <AiCheckup running={running} />
    {running ? <><MimirBrain /><ModelLibrary /></> : <p className="hint">Start Mimir to choose its engine and download models here.</p>}
    <div className="settings-block">
      <h3>ChatGPT side panel</h3>
      <p className="hint">Separate from Mimir: chatgpt.com in a panel, signed in with your own account ({MOD} J, or the button in the top bar). “Ask ChatGPT” in Study, Projects and the Browser puts the question in its message box for you to send, and “Save to BridgeDeck” makes the chat a note.</p>
      <div className="actions"><button className="secondary" onClick={toggleChatPanel}><MessageCircleQuestion size={15}/>Open ChatGPT</button></div>
    </div>
    <div className="settings-block">
      <h3>Agents</h3>
      <p className="hint">Other AI assistants (Claude Code, Codex…) that connect to BridgeDeck show up under AI → Agents, where they share rooms and claim files so they don’t clash. Mimir can post in those rooms too.</p>
      <div className="actions"><button className="secondary" onClick={() => activateTab('ai')}><Bot size={15}/>Open Agents</button></div>
    </div>
    <SkillPacks />
    <ActivityLog />
  </Card>
}

/** Everything Mimir changed in BridgeDeck or sent, newest first. */
function ActivityLog() {
  const [items, setItems] = useState<MimirActivity[]>([])
  const [all, setAll] = useState(false)
  useEffect(() => {
    if (!isTauri()) return
    const load = () => void mimirActivity().then(setItems).catch(() => undefined)
    load()
    const timer = window.setInterval(load, 10_000)
    return () => window.clearInterval(timer)
  }, [])
  const shown = all ? items : items.slice(0, 12)
  return <div className="settings-block">
    <h3>What Mimir did</h3>
    {items.length ? <div className="activity-list">{shown.map((a, i) => <div key={`${a.at}-${i}`} className={`activity-row${a.ok ? '' : ' failed'}`}>
      <small>{new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
      <span className="grow"><strong>{a.action}{a.outward ? ' (you were asked)' : ''}</strong>{a.detail && <em>{a.detail}</em>}</span>
    </div>)}</div> : <p className="hint">Nothing yet. Notes, events, tasks and flashcards Mimir makes, and anything it sends, appear here.</p>}
    {items.length > 12 && <div className="actions"><button className="secondary" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button></div>}
  </div>
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

export const mimir: FeatureManifest = { id: 'mimir', title: 'Mimir', icon: Brain, Page: MimirPage, keepAlive: true, mountAtStart: true, Background: MimirBackground, Settings: MimirSettings, settingsOrder: 45 }
