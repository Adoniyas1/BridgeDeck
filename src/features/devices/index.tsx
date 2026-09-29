import { ArrowLeftRight, Computer, FolderOpen, Gauge, HardDrive, Plus, RefreshCw, ShieldCheck, Square, TerminalSquare, Trash2, Wifi } from 'lucide-react'
import { openPath } from '../../lib/bridge'
import {
  approveAutomaticPair, bridgeLinkStore, declineAutomaticPair, forgetAutomaticPair, deviceStatusStore, pairingStateStore,
  requestAutomaticPair, startAutomaticPairing, stopAutomaticPairing,
} from '../../core/bridgelink'
import { removeDevice, setConfig, sortedDevices, updateDevice, upsertDevice, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { fmtBytes, fmtUptime, platformLabel } from '../../core/util'
import { Card, SectionTitle, StatusPill, Toggle } from '../../ui'
import type { DeviceConfig } from '../../types'
import type { FeatureManifest } from '../features'
import { startRustDeskSession } from '../remote/state'
import { configureSyncthingPeer, syncthingSetupStore } from '../sync/state'

const isManual = (device: DeviceConfig) => device.id.startsWith('manual-')
const connectionLabel = (device: DeviceConfig) => device.local ? 'This computer'
  : !isManual(device) ? `BridgeLink paired${device.syncthingDeviceId ? ' + sync ID' : ''}` : device.agentToken ? 'Bearer token' : 'Manual'

function addManualDevice() {
  upsertDevice(`manual-${crypto.randomUUID()}`, {}, { name: 'New computer', platform: '', local: false })
}

function DevicesPage() {
  const config = useConfig()
  const bridgeLink = useStore(bridgeLinkStore)
  const pairingState = useStore(pairingStateStore)
  const machineStatus = useStore(deviceStatusStore)
  const syncthingSetup = useStore(syncthingSetupStore)
  const unpaired = bridgeLink.discovered.filter(peer => !bridgeLink.paired.some(paired => paired.instanceId === peer.instanceId))
  return <>
    <Card className="pairing-card"><SectionTitle title="Automatic pairing" subtitle={pairingState} action={<StatusPill online={bridgeLink.running} label={bridgeLink.running ? 'Discovering' : 'Stopped'}/>} />
      <div className="pairing-summary"><div><Wifi size={20}/><span><strong>{bridgeLink.displayName || 'BridgeDeck'}</strong><small>{bridgeLink.running ? `LAN discovery · TCP ${bridgeLink.apiPort}` : 'Start pairing to discover your other computers'}</small></span></div><div className="actions"><button className="secondary" onClick={() => void startAutomaticPairing()}><RefreshCw size={16}/>Restart discovery</button></div></div>
      {bridgeLink.outgoing && <div className="pair-request outgoing"><div><strong>Waiting for {bridgeLink.outgoing.peerName}</strong><small>Verify this code on both computers before approving.</small></div><code>{bridgeLink.outgoing.pairingCode}</code></div>}
      {!!bridgeLink.pending.length && <div className="pair-section"><h3>Incoming requests</h3>{bridgeLink.pending.map(request => <div className="pair-request" key={request.requestId}><div><strong>{request.peerName}</strong><small>{request.peerPlatform} · {request.host}</small></div><code>{request.pairingCode}</code><div className="actions"><button onClick={() => void approveAutomaticPair(request.requestId)}><ShieldCheck size={16}/>Approve</button><button className="secondary" onClick={() => void declineAutomaticPair(request.requestId)}>Decline</button></div></div>)}</div>}
      <div className="pair-section"><h3>Discovered computers</h3>{unpaired.length ? <div className="pair-list">{unpaired.map(peer => <div className="pair-peer" key={peer.instanceId}><div><Computer size={18}/><span><strong>{peer.name}</strong><small>{peer.platform} · {peer.host}:{peer.apiPort}</small></span></div><button disabled={!!bridgeLink.outgoing} onClick={() => void requestAutomaticPair(peer)}>Pair</button></div>)}</div> : <div className="bb-placeholder">{bridgeLink.running ? 'Waiting for another BridgeDeck instance on this LAN…' : 'Automatic discovery is stopped.'}</div>}</div>
      {!!bridgeLink.paired.length && <div className="pair-section"><h3>Paired</h3><div className="pair-list">{bridgeLink.paired.map(peer => { const syncState = syncthingSetup[peer.instanceId]; return <div className="pair-peer" key={peer.instanceId}><div><ShieldCheck size={18}/><span><strong>{peer.name}</strong><small>{peer.platform} · RustDesk {peer.rustdeskPeerId || 'not reported'} · LocalSend {peer.localsendTarget} · Syncthing {peer.syncthingDeviceId ? 'ID received' : 'waiting for ID'}</small>{syncState && <small>{'error' in syncState ? syncState.error : syncState.detail}</small>}</span></div><div className="actions"><button className="secondary" disabled={!config.syncthing.apiKey} onClick={() => void configureSyncthingPeer(peer)}><ArrowLeftRight size={16}/>Setup sync</button><button className="ghost" title="Forget pairing" onClick={() => void forgetAutomaticPair(peer.instanceId)}><Trash2 size={16}/></button></div></div> })}</div></div>}
      <p className="vendor-note">Pair only on a trusted LAN and confirm the six-digit code on both screens. v0.7 authenticates paired status requests with persisted bearer tokens and exchanges Syncthing device IDs; the initial LAN token exchange is not yet TLS-encrypted.</p>
    </Card>
    <div className="machine-cards">
      {sortedDevices(config.devices).map(m => { const status = machineStatus[m.id]; return <Card key={m.id}><SectionTitle title={m.name} subtitle={status?.hostname || m.agentUrl || platformLabel(m.platform)} action={<StatusPill online={!!status?.ok}/>} /><div className="spec-grid"><div><Gauge/><span>Uptime<strong>{fmtUptime(status?.uptimeSeconds)}</strong></span></div><div><HardDrive/><span>Memory free<strong>{fmtBytes(status?.freeMemory)}</strong></span></div><div><TerminalSquare/><span>Platform<strong>{status?.platform || platformLabel(m.platform)} {status?.arch || ''}</strong></span></div><div><ShieldCheck/><span>Connection<strong>{connectionLabel(m)}</strong></span></div></div><div className="actions">{!m.local && <button disabled={!m.rustdeskPeerId} onClick={() => void startRustDeskSession(m, 'control')}><Computer size={17}/>Control</button>}<button className="secondary" disabled={!m.sharedPath} onClick={() => void openPath(m.sharedPath)}><FolderOpen size={17}/>Shared folder</button></div>{status?.error && <p className="error-text">{status.error}</p>}</Card> })}
    </div>
  </>
}

function DevicesSettings() {
  const config = useConfig()
  const bridgeLink = useStore(bridgeLinkStore)
  return <>
    <Card><SectionTitle title="Automatic pairing" subtitle="BridgeLink discovers and pairs BridgeDeck instances on the same LAN" action={<StatusPill online={bridgeLink.running} label={bridgeLink.running ? 'Running' : 'Stopped'}/>} /><label>Computer display name<input value={config.pairing.displayName} onChange={e => setConfig(c => ({ ...c, pairing: { ...c.pairing, displayName: e.target.value } }))} placeholder="Blank = system computer name"/></label><label>BridgeLink API port<input type="number" value={config.pairing.apiPort} onChange={e => setConfig(c => ({ ...c, pairing: { ...c.pairing, apiPort: Number(e.target.value) || 41416 } }))}/></label><Toggle checked={config.pairing.autoStart} onChange={autoStart => setConfig(c => ({ ...c, pairing: { ...c.pairing, autoStart } }))} label="Start LAN discovery automatically"/><div className="actions"><button onClick={() => void startAutomaticPairing()}><Wifi size={17}/>Start / restart pairing</button><button className="secondary" onClick={() => void stopAutomaticPairing()}><Square size={16}/>Stop</button></div><p className="vendor-note">Discovery uses UDP multicast port 41415. The status/pairing API defaults to TCP 41416. Approve only when the six-digit code matches on both computers.</p></Card>
    <Card><SectionTitle title="Computers" subtitle="BridgeLink pairing fills these fields automatically; manual overrides remain available" action={<button className="ghost" onClick={addManualDevice}><Plus size={15}/>Add computer manually</button>} />{sortedDevices(config.devices).map(m => <div className="settings-block" key={m.id}><div className="settings-heading"><h3>{m.local ? `${m.name} (this computer)` : m.name}</h3>{isManual(m) && <button className="ghost" title="Remove" onClick={() => removeDevice(m.id)}><Trash2 size={15}/></button>}</div><label>Name<input value={m.name} onChange={e => updateDevice(m.id, { name: e.target.value })}/></label><label>Agent URL<input value={m.agentUrl} onChange={e => updateDevice(m.id, { agentUrl: e.target.value })}/></label><label>Agent bearer token<input type="password" value={m.agentToken} onChange={e => updateDevice(m.id, { agentToken: e.target.value })} placeholder="Blank for localhost-only agent"/></label><label>RustDesk peer ID<input value={m.rustdeskPeerId} onChange={e => updateDevice(m.id, { rustdeskPeerId: e.target.value })} placeholder="Numeric RustDesk ID"/></label><label>LocalSend target<input value={m.localsendTarget} onChange={e => updateDevice(m.id, { localsendTarget: e.target.value })} placeholder="Exact LocalSend alias or LAN IP"/></label><label>Remote LocalSend PIN<input type="password" value={m.localsendPin} onChange={e => updateDevice(m.id, { localsendPin: e.target.value })} placeholder="Only if that receiver requires one"/></label><label>Syncthing device ID<input value={m.syncthingDeviceId} onChange={e => updateDevice(m.id, { syncthingDeviceId: e.target.value })} placeholder="Filled automatically after pairing"/></label><label>Shared folder path<input value={m.sharedPath} onChange={e => updateDevice(m.id, { sharedPath: e.target.value })}/></label></div>)}{!config.devices.length && <div className="bb-placeholder">Computers appear here once BridgeLink starts and pairs.</div>}</Card>
  </>
}

export const devices: FeatureManifest = { id: 'computers', title: 'Computers', icon: Computer, Page: DevicesPage, Settings: DevicesSettings, settingsOrder: 10 }
