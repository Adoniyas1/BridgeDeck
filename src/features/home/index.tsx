import { ArrowLeftRight, ClipboardCopy, Computer, FolderSync, Home, MessageSquare, MonitorUp, PackageX, TriangleAlert, Upload } from 'lucide-react'
import { bridgeLinkStore, deviceStatusStore } from '../../core/bridgelink'
import { sortedDevices, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle, StatusPill } from '../../ui'
import type { FeatureManifest } from '../features'
import { clipboardDetail, clipboardStore } from '../devices/clipboard'
import { receiverStore } from '../files/state'
import { messagesSourceStore } from '../messages/state'
import { controlDevice, hostStore } from '../remote/state'
import { syncthingStore } from '../sync/state'
import { leftoverStore, LeftoverBackground, stopLeftovers } from './leftovers'

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
    <Leftovers />
    <div className="hero-grid">
      <Card><div className="metric-icon"><Computer /></div><div className="metric"><span>Computers online</span><strong>{onlineMachines}<small>/ {devices.length}</small></strong></div></Card>
      <Card><div className="metric-icon"><FolderSync /></div><div className="metric"><span>Built-in features ready</span><strong>{builtIn.filter(f => f.on).length}<small>/ {builtIn.length}</small></strong></div></Card>
      <Card><div className="metric-icon"><ArrowLeftRight /></div><div className="metric"><span>Bridge state</span><strong className="metric-word">{onlineMachines ? 'Connected' : 'Waiting'}</strong></div></Card>
    </div>
    <div className="two-col">
      <Card><SectionTitle title="Computers" subtitle="Paired devices, and one click to control them" />
        <div className="stack">{devices.map(m => {
          const peer = paired.find(p => p.instanceId === m.id)
          return <div className="machine-row" key={m.id}><div className="machine-avatar"><Computer size={22}/></div><div className="grow"><strong>{m.name}</strong><small>{machineStatus[m.id]?.hostname || (m.local ? 'This computer' : '')}</small></div><StatusPill online={!!machineStatus[m.id]?.ok}/>{!m.local && <button className="ghost" disabled={!peer || !canHost(peer.platform)} onClick={() => peer && controlDevice({ id: peer.instanceId, name: peer.name })}>Control</button>}</div>
        })}</div>
      </Card>
      <Card><SectionTitle title="Built in" subtitle="Everything runs inside BridgeDeck; no other apps needed" />
        <div className="stack compact">{builtIn.map(f => <button className="service-row" key={f.name} onClick={() => activateTab(f.tab)}><span className="service-dot" data-on={f.on}/><f.icon size={16}/><div className="grow"><strong>{f.name}</strong><small>{f.detail}</small></div></button>)}</div>
      </Card>
    </div>
  </>
}

export const home: FeatureManifest = { id: 'home', title: 'Home', icon: Home, Page: HomePage, Background: LeftoverBackground }
