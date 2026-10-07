import { ArrowLeftRight, CheckCircle2, CircleAlert, ClipboardCopy, Computer, FolderSync, Home, MessageSquare, MonitorUp, PackageX, TriangleAlert, Upload } from 'lucide-react'
import { useState } from 'react'
import { bridgeLinkStore, deviceStatusStore, startAutomaticPairing, wakeDevice } from '../../core/bridgelink'
import { serviceConfig, setConfig, sortedDevices, useConfig } from '../../core/config'
import { usePeriodicRefresh } from '../../core/refresh'
import { healthPermissions, isTauri, openPrivacySettings, type Permissions } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle, StatusPill } from '../../ui'
import type { FeatureManifest } from '../features'
import { clipboardDetail, clipboardStore } from '../devices/clipboard'
import { receiverStore, startLocalSendReceiver } from '../files/state'
import { messagesSourceStore } from '../messages/state'
import { controlDevice, hostStore } from '../remote/state'
import { conflictsStore, sidecarStore, startBuiltIn, syncthingStore } from '../sync/state'
import { healthIssues, type Fix, type HealthInput } from './health'
import { setupSteps, type SetupFix } from './setup'
import DiagnosticsButton from '../../shell/DiagnosticsButton'
import { installUpdate, updatesStore } from '../devices/updates'
import { leftoverStore, LeftoverBackground, stopLeftovers } from './leftovers'
import TodayAgenda from '../calendar/Agenda'
import { DueSoonCard } from '../study/AssignmentCards'
import { AwayCard, BriefBackground, BriefCard, BriefSettings } from './brief-ui'

const canHost = (platform?: string) => platform === 'macos' || platform === 'windows'

function Leftovers() {
  const { apps, busy } = useStore(leftoverStore)
  if (!apps.length) return null
  const needsUninstall = apps.filter(a => a.systemService || a.installed)
  const stillActive = apps.some(a => a.running || a.startsAtLogin)
  return <Card className="incoming-card"><SectionTitle title="Apps BridgeDeck no longer needs" subtitle="BridgeDeck now does their jobs itself" action={<PackageX size={20}/>} />
    <div className="stack">{apps.map(app => <div className="service-row" key={app.name}>
      <span className="service-dot" data-on={app.running}/>
      <div className="grow"><strong>{app.name}</strong><small>Replaced by {app.replacedBy}. {[app.running && 'Running', app.startsAtLogin && 'starts at login', app.systemService && 'installed as a system service', app.installed && 'installed'].filter(Boolean).join(', ')}</small></div>
    </div>)}</div>
    <div className="actions">{stillActive && <button disabled={busy} onClick={() => void stopLeftovers()}>{busy ? 'Stopping…' : 'Quit them and stop them opening at login'}</button>}</div>
    {!!needsUninstall.length && <p className="pair-note">To remove them completely, uninstall {needsUninstall.map(a => a.name).join(' and ')}: {navigator.userAgent.includes('Mac') ? 'drag the app from Applications to the Trash (RustDesk asks for your password to remove its service)' : 'Settings → Apps → Installed apps → Uninstall'}.{needsUninstall.some(a => a.systemService) ? ' RustDesk’s background service starts it again until it’s uninstalled.' : ''}</p>}
  </Card>
}

const openedAt = Date.now()

export const FIXES: Record<Fix, () => unknown> = {
  update: installUpdate,
  'start-pairing': startAutomaticPairing,
  pair: () => activateTab('computers'),
  'files-access': () => openPrivacySettings('files'),
  'screen-recording': () => openPrivacySettings('screen'),
  accessibility: () => openPrivacySettings('accessibility'),
  'start-sync': startBuiltIn,
  'start-receiver': startLocalSendReceiver,
  'open-sync': () => activateTab('sync'),
}

/** Problems BridgeDeck can see, each with the click that fixes it. Hidden when all is well. */
/** Everything the health checks look at, live. */
export function useHealthInput(): HealthInput {
  const config = useConfig()
  const link = useStore(bridgeLinkStore)
  const messages = useStore(messagesSourceStore)
  const sidecar = useStore(sidecarStore)
  const receiver = useStore(receiverStore)
  const clipboard = useStore(clipboardStore)
  const conflicts = useStore(conflictsStore)
  const updates = useStore(updatesStore)
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  usePeriodicRefresh(async () => { if (isTauri()) setPermissions(await healthPermissions()) }, 10_000, [])
  return {
    pairingRunning: link.running,
    pairedCount: link.paired.length,
    mac: link.platform === 'macos',
    messages,
    permissions,
    remoteAllowed: config.remote.allowControl,
    sync: { builtin: config.syncthing.mode === 'builtin', available: sidecar.available, running: sidecar.running },
    receiver: { enabled: !!serviceConfig(config, 'localsend')?.enabled, running: receiver.running },
    clipboard: { on: config.clipboard.sync, available: clipboard.available || !isTauri() },
    conflicts: Object.values(conflicts).flat().length,
    update: { behind: updates.behind, installing: updates.installing },
    settled: Date.now() - openedAt > 20_000,
  }
}

const SETUP_FIXES: Record<SetupFix, () => unknown> = {
  pair: FIXES.pair,
  'start-pairing': FIXES['start-pairing'],
  'files-access': FIXES['files-access'],
  'screen-recording': FIXES['screen-recording'],
  accessibility: FIXES.accessibility,
  'start-sync': FIXES['start-sync'],
  'start-receiver': FIXES['start-receiver'],
  'open-mimir': () => activateTab('mimir'),
  'review-notifications': () => {
    setConfig(c => ({ ...c, setup: { ...c.setup, notificationsReviewed: true } }))
    activateTab('settings')
  },
}

/** First-run checklist: ticks itself as things start working; closed for good with Done. */
function SetupChecklist() {
  const config = useConfig()
  const steps = setupSteps({ ...useHealthInput(), mimirEnabled: config.mimir.enabled, notificationsReviewed: config.setup.notificationsReviewed })
  const required = steps.filter(s => !s.optional)
  const done = required.filter(s => s.done).length
  const finish = () => setConfig(c => ({ ...c, setup: { ...c.setup, dismissed: true } }))
  return <Card className="incoming-card setup-card"><SectionTitle title={done === required.length ? 'All set' : 'Set up BridgeDeck'} subtitle={`${done} of ${required.length} done${done === required.length ? ': your computers are connected' : ''}`} action={<CheckCircle2 size={20}/>} />
    <div className="stack">{steps.map(step => <div className="service-row" key={step.id}>
      <span className="service-dot" data-on={step.done}/>
      <div className="grow"><strong>{step.title}</strong><small>{step.detail}</small></div>
      {step.fix && <button className="secondary" onClick={() => void Promise.resolve(SETUP_FIXES[step.fix!.action]()).catch(() => undefined)}>{step.fix.label}</button>}
    </div>)}</div>
    <div className="actions"><button onClick={finish}>{done === required.length ? 'Done' : 'Skip for now'}</button><small className="vendor-note">You can open this again from Settings. Anything that breaks later shows up on Home.</small></div>
  </Card>
}

function NeedsAttention() {
  const issues = healthIssues(useHealthInput())
  if (!issues.length) return null
  return <Card className="incoming-card"><SectionTitle title="Needs attention" subtitle={`${issues.length} thing${issues.length === 1 ? '' : 's'} to fix`} action={<CircleAlert size={20}/>} />
    <div className="stack">{issues.map(issue => <div className="service-row" key={issue.id}>
      <span className="service-dot" data-on={false}/>
      <div className="grow"><strong>{issue.title}</strong><small>{issue.detail}</small></div>
      {issue.fix && <button className="secondary" onClick={() => void Promise.resolve(FIXES[issue.fix!.action]()).catch(() => undefined)}>{issue.fix.label}</button>}
    </div>)}</div>
    <div className="actions"><DiagnosticsButton /></div>
  </Card>
}

function HomePage() {
  const config = useConfig()
  const machineStatus = useStore(deviceStatusStore)
  const paired = useStore(bridgeLinkStore).paired
  const receiver = useStore(receiverStore)
  const syncthing = useStore(syncthingStore)
  const messages = useStore(messagesSourceStore)
  const host = useStore(hostStore)
  const clipboard = useStore(clipboardStore)
  const devices = sortedDevices(config.devices)
  const onlineMachines = devices.filter(d => machineStatus[d.id]?.ok).length
  const builtIn = [
    { name: 'Files', icon: Upload, on: receiver.running, detail: receiver.running ? `Receiving as ${receiver.alias}` : 'Receiver stopped', tab: 'files' },
    { name: 'Sync', icon: FolderSync, on: syncthing.ok, detail: syncthing.ok ? 'Syncing (runs inside BridgeDeck)' : 'Starting…', tab: 'sync' },
    { name: 'Messages', icon: MessageSquare, on: messages.ready, detail: messages.ready ? `From ${messages.name}` : messages.detail || 'Looking for your Mac…', tab: 'messages' },
    { name: 'Remote', icon: MonitorUp, on: true, detail: host.sessions.length ? `${host.sessions.map(s => s.peerName).join(', ')} is controlling this computer` : host.supported ? (config.remote.allowControl ? 'Paired devices can control this computer' : 'Control of this computer is off') : 'Can control your other computers', tab: 'remote' },
    { name: 'Clipboard', icon: ClipboardCopy, on: config.clipboard.sync && clipboard.available, detail: clipboardDetail(clipboard, config.clipboard.sync), tab: 'computers' },
  ]
  // Every online computer should run the same build; 0.7 and older don't report a version.
  const versions = new Set(devices.filter(d => machineStatus[d.id]?.ok).map(d => machineStatus[d.id]?.version || '0.7 or older'))
  return <>
    {versions.size > 1 && <div className="notice"><TriangleAlert size={15}/><span>Your computers run different BridgeDeck builds ({[...versions].join(', ')}). Update them all to the same version.</span></div>}
    {config.setup.dismissed ? <NeedsAttention /> : <SetupChecklist />}
    <Leftovers />
    <AwayCard />
    <TodayAgenda />
    <DueSoonCard />
    <BriefCard />
    <div className="hero-grid">
      <Card><div className="metric-icon"><Computer /></div><div className="metric"><span>Computers online</span><strong>{onlineMachines}<small>/ {devices.length}</small></strong></div></Card>
      <Card><div className="metric-icon"><FolderSync /></div><div className="metric"><span>Built-in features ready</span><strong>{builtIn.filter(f => f.on).length}<small>/ {builtIn.length}</small></strong></div></Card>
      <Card><div className="metric-icon"><ArrowLeftRight /></div><div className="metric"><span>Bridge state</span><strong className="metric-word">{onlineMachines ? 'Connected' : 'Waiting'}</strong></div></Card>
    </div>
    <div className="two-col">
      <Card><SectionTitle title="Computers" subtitle="Paired devices, and one click to control them" />
        <div className="stack">{devices.map(m => {
          const peer = paired.find(p => p.instanceId === m.id)
          return <div className="machine-row" key={m.id}><div className="machine-avatar"><Computer size={22}/></div><div className="grow"><strong>{m.name}</strong><small>{machineStatus[m.id]?.hostname || (m.local ? 'This computer' : '')}</small></div><StatusPill online={!!machineStatus[m.id]?.ok}/>{!m.local && peer?.wakeable && !machineStatus[m.id]?.ok && <button className="ghost" title="Wake-on-LAN (same network only)" onClick={() => void wakeDevice(peer.instanceId)}>Wake</button>}{!m.local && <button className="ghost" disabled={!peer || !canHost(peer.platform)} onClick={() => peer && controlDevice({ id: peer.instanceId, name: peer.name })}>Control</button>}</div>
        })}</div>
      </Card>
      <Card><SectionTitle title="Built in" subtitle="Everything runs inside BridgeDeck; no other apps needed" action={<DiagnosticsButton className="ghost" />} />
        <div className="stack compact">{builtIn.map(f => <button className="service-row" key={f.name} onClick={() => activateTab(f.tab)}><span className="service-dot" data-on={f.on}/><f.icon size={16}/><div className="grow"><strong>{f.name}</strong><small>{f.detail}</small></div></button>)}</div>
      </Card>
    </div>
  </>
}

function HomeBackground() {
  return <><LeftoverBackground /><BriefBackground /></>
}

export const home: FeatureManifest = { id: 'home', title: 'Home', icon: Home, Page: HomePage, Background: HomeBackground, Settings: BriefSettings, settingsOrder: 36 }
