import { ArrowLeftRight, Computer, Download, FolderOpen, Gauge, HardDrive, Info, Lock, Plus, RefreshCw, ShieldCheck, Square, TerminalSquare, Trash2, Wifi } from 'lucide-react'
import { openPath } from '../../lib/bridge'
import {
  approveAutomaticPair, bridgeLinkStore, confirmOutgoingPair, declineAutomaticPair, deviceStatusStore, forgetAutomaticPair,
  pairingStateStore, requestAutomaticPair, startAutomaticPairing, stopAutomaticPairing, upgradeLegacyPeer,
} from '../../core/bridgelink'
import { removeDevice, setConfig, sortedDevices, updateDevice, upsertDevice, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { fmtBytes, fmtUptime, platformLabel } from '../../core/util'
import { Card, SectionTitle, StatusPill, Toggle } from '../../ui'
import type { DeviceConfig } from '../../types'
import type { FeatureManifest } from '../features'
import { controlDevice } from '../remote/state'
import { configureSyncthingPeer, syncthingSetupStore } from '../sync/state'
import { UpgradeControls } from './UpgradeControls'
import { ClipboardBackground, ClipboardCard } from './clipboard'
import { TrayBackground } from './tray'
import { UpdatesBackground, UpdatesCard } from './updates'
import { version } from '../../../package.json'

const isManual = (device: DeviceConfig) => device.id.startsWith('manual-')
const connectionLabel = (device: DeviceConfig, via?: string) => device.local ? 'This computer'
  : !isManual(device) ? `Encrypted${via === 'tailscale' ? ' via Tailscale' : ''}` : device.agentToken ? 'Bearer token' : 'Manual'
/** Codes are read out loud or compared at a glance: "123 456". */
const spaced = (code: string) => code ? `${code.slice(0, 3)} ${code.slice(3)}` : '······'

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
  const outgoing = bridgeLink.outgoing
  const legacy = bridgeLink.legacy ?? []
  const viaOf = (id: string) => bridgeLink.paired.find(p => p.instanceId === id)?.via
  return <>
    <Card className="pairing-card"><SectionTitle title="Automatic pairing" subtitle={pairingState} action={<StatusPill online={bridgeLink.running} label={bridgeLink.running ? 'Discovering' : 'Stopped'}/>} />
      <div className="pairing-summary"><div><Wifi size={20}/><span><strong>{bridgeLink.displayName || 'BridgeDeck'}</strong><small>{bridgeLink.running ? `Looking for your devices on this network${bridgeLink.tailscale ? ' and Tailscale' : ''}` : 'Start pairing to discover your other computers'}</small></span></div><div className="actions"><button className="secondary" onClick={() => void startAutomaticPairing()}><RefreshCw size={16}/>Restart discovery</button></div></div>
      {outgoing && <div className="pair-request outgoing"><div>
          <strong>{outgoing.state === 'connecting' ? `Connecting securely to ${outgoing.peerName}…` : outgoing.state === 'waiting' ? `Waiting for ${outgoing.peerName} to confirm` : `Pairing with ${outgoing.peerName}`}</strong>
          <small>{outgoing.state === 'confirm' ? `Does ${outgoing.peerName} show the same code? Confirm on both computers.` : 'The code appears on both computers.'}</small>
        </div><code>{spaced(outgoing.pairingCode)}</code>
        {outgoing.state === 'confirm' && <div className="actions"><button onClick={() => void confirmOutgoingPair(true)}><ShieldCheck size={16}/>Codes match</button><button className="secondary" onClick={() => void confirmOutgoingPair(false)}>Cancel</button></div>}
        {outgoing.state === 'connecting' && <div className="actions"><button className="secondary" onClick={() => void confirmOutgoingPair(false)}>Cancel</button></div>}
      </div>}
      {!!bridgeLink.pending.length && <div className="pair-section"><h3>Pairing requests</h3>{bridgeLink.pending.map(request => <div className="pair-request" key={request.requestId}><div><strong>{request.peerName}</strong><small>{request.state === 'approved' ? `Waiting for ${request.peerName} to confirm` : `${request.peerPlatform} · ${request.host} · approve only if ${request.peerName} shows the same code`}</small></div><code>{spaced(request.pairingCode)}</code>{request.state === 'waiting' && <div className="actions"><button onClick={() => void approveAutomaticPair(request.requestId)}><ShieldCheck size={16}/>Codes match</button><button className="secondary" onClick={() => void declineAutomaticPair(request.requestId)}>Decline</button></div>}</div>)}</div>}
      <div className="pair-section"><h3>Discovered computers</h3>{unpaired.length ? <div className="pair-list">{unpaired.map(peer => <div className="pair-peer" key={peer.instanceId}><div><Computer size={18}/><span><strong>{peer.name}</strong><small>{peer.platform} · {peer.host}{peer.via === 'tailscale' ? ' · Tailscale' : ''}{peer.protocol < 2 ? ' · older BridgeDeck, update it first' : ''}</small></span></div><button disabled={!!outgoing || peer.protocol < 2} onClick={() => void requestAutomaticPair(peer)}>Pair</button></div>)}</div> : <div className="bb-placeholder">{bridgeLink.running ? 'Waiting for another BridgeDeck on this network…' : 'Automatic discovery is stopped.'}</div>}</div>
      {!!legacy.length && <div className="pair-section"><h3>Pair again</h3><p className="pair-note">These computers were paired with an older BridgeDeck that sent passwords unencrypted. Update them, then pair again.</p><div className="pair-list">{legacy.map(peer => <div className="pair-peer" key={peer.instanceId}><div><Computer size={18}/><span><strong>{peer.name}</strong><small>{peer.platform} · {peer.host}</small></span></div><div className="actions"><button className="secondary" onClick={() => void upgradeLegacyPeer(peer.instanceId, peer.name, version)}><Download size={16}/>Ask it to update</button><button className="ghost" title="Forget" onClick={() => void forgetAutomaticPair(peer.instanceId)}><Trash2 size={16}/></button></div></div>)}</div></div>}
      {!!bridgeLink.paired.length && <div className="pair-section"><h3>Paired</h3><div className="pair-list">{bridgeLink.paired.map(peer => { const syncState = syncthingSetup[peer.instanceId]; return <div className="pair-peer" key={peer.instanceId}><div><Lock size={18}/><span><strong>{peer.name}</strong><small>{peer.platform} · {peer.via === 'tailscale' ? 'Tailscale' : 'local network'} · Syncthing {peer.syncthingDeviceId ? 'ID received' : 'waiting for ID'}</small>{syncState && <small>{'error' in syncState ? syncState.error : syncState.detail}</small>}</span></div><div className="actions"><button className="secondary" disabled={!config.syncthing.apiKey} onClick={() => void configureSyncthingPeer(peer)}><ArrowLeftRight size={16}/>Setup sync</button><button className="ghost" title="Forget pairing" onClick={() => void forgetAutomaticPair(peer.instanceId)}><Trash2 size={16}/></button></div></div> })}</div></div>}
      <p className="vendor-note">Pairing and everything after it is encrypted. Confirm only when both computers show the same six-digit code.{bridgeLink.fingerprint ? ` This computer's key: ${bridgeLink.fingerprint.slice(0, 16)}…` : ''}</p>
    </Card>
    <ClipboardCard />
    <div className="machine-cards">
      {sortedDevices(config.devices).map(m => { const status = machineStatus[m.id]; return <Card key={m.id}><SectionTitle title={m.name} subtitle={status?.hostname || m.agentUrl || platformLabel(m.platform)} action={<StatusPill online={!!status?.ok}/>} /><div className="spec-grid"><div><Gauge/><span>Uptime<strong>{fmtUptime(status?.uptimeSeconds)}</strong></span></div><div><HardDrive/><span>Memory free<strong>{fmtBytes(status?.freeMemory)}</strong></span></div><div><TerminalSquare/><span>Platform<strong>{status?.platform || platformLabel(m.platform)} {status?.arch || ''}</strong></span></div><div><ShieldCheck/><span>Connection<strong>{connectionLabel(m, viaOf(m.id))}</strong></span></div><div><Info/><span>BridgeDeck<strong>{status?.version || (status?.ok ? '0.7 or older' : '—')}</strong></span></div></div><div className="actions">{!m.local && <button disabled={!bridgeLink.paired.some(p => p.instanceId === m.id && (p.platform === 'macos' || p.platform === 'windows'))} onClick={() => controlDevice({ id: m.id, name: m.name })}><Computer size={17}/>Control</button>}<button className="secondary" disabled={!m.sharedPath} onClick={() => void openPath(m.sharedPath)}><FolderOpen size={17}/>Shared folder</button></div>{(m.local || !isManual(m)) && <UpgradeControls device={m} peerVersion={status?.version} online={!!status?.ok} />}{status?.error && <p className="error-text">{status.error}</p>}</Card> })}
    </div>
  </>
}

/** The clipboard thread's setting, the tray menu's device lists and update checks. */
function DevicesBackground() {
  return <><ClipboardBackground /><TrayBackground /><UpdatesBackground /></>
}

function DevicesSettings() {
  const config = useConfig()
  const bridgeLink = useStore(bridgeLinkStore)
  return <>
    <Card><SectionTitle title="Automatic pairing" subtitle="BridgeLink discovers and pairs BridgeDeck instances on the same LAN" action={<StatusPill online={bridgeLink.running} label={bridgeLink.running ? 'Running' : 'Stopped'}/>} /><label>Computer display name<input value={config.pairing.displayName} onChange={e => setConfig(c => ({ ...c, pairing: { ...c.pairing, displayName: e.target.value } }))} placeholder="Blank = system computer name"/></label><label>BridgeLink API port<input type="number" value={config.pairing.apiPort} onChange={e => setConfig(c => ({ ...c, pairing: { ...c.pairing, apiPort: Number(e.target.value) || 41416 } }))}/></label><Toggle checked={config.pairing.autoStart} onChange={autoStart => setConfig(c => ({ ...c, pairing: { ...c.pairing, autoStart } }))} label="Start LAN discovery automatically"/><div className="actions"><button onClick={() => void startAutomaticPairing()}><Wifi size={17}/>Start / restart pairing</button><button className="secondary" onClick={() => void stopAutomaticPairing()}><Square size={16}/>Stop</button></div><p className="vendor-note">Discovery uses UDP 41415 (multicast on the local network, direct to Tailscale devices). Paired devices talk over encrypted QUIC on UDP 41416; the local API for AI tools listens on 127.0.0.1:41416 only.</p></Card>
    <UpdatesCard />
    <Card><SectionTitle title="Computers" subtitle="BridgeLink pairing fills these fields automatically; manual overrides remain available" action={<button className="ghost" onClick={addManualDevice}><Plus size={15}/>Add computer manually</button>} />{sortedDevices(config.devices).map(m => <div className="settings-block" key={m.id}><div className="settings-heading"><h3>{m.local ? `${m.name} (this computer)` : m.name}</h3>{isManual(m) && <button className="ghost" title="Remove" onClick={() => removeDevice(m.id)}><Trash2 size={15}/></button>}</div><label>Name<input value={m.name} onChange={e => updateDevice(m.id, { name: e.target.value })}/></label><label>Agent URL<input value={m.agentUrl} onChange={e => updateDevice(m.id, { agentUrl: e.target.value })}/></label><label>Agent bearer token<input type="password" value={m.agentToken} onChange={e => updateDevice(m.id, { agentToken: e.target.value })} placeholder="Blank for localhost-only agent"/></label><label>LocalSend target<input value={m.localsendTarget} onChange={e => updateDevice(m.id, { localsendTarget: e.target.value })} placeholder="Exact LocalSend alias or LAN IP"/></label><label>Remote LocalSend PIN<input type="password" value={m.localsendPin} onChange={e => updateDevice(m.id, { localsendPin: e.target.value })} placeholder="Only if that receiver requires one"/></label><label>Syncthing device ID<input value={m.syncthingDeviceId} onChange={e => updateDevice(m.id, { syncthingDeviceId: e.target.value })} placeholder="Filled automatically after pairing"/></label><label>Shared folder path<input value={m.sharedPath} onChange={e => updateDevice(m.id, { sharedPath: e.target.value })}/></label></div>)}{!config.devices.length && <div className="bb-placeholder">Computers appear here once BridgeLink starts and pairs.</div>}</Card>
  </>
}

export const devices: FeatureManifest = { id: 'computers', title: 'Computers', icon: Computer, Page: DevicesPage, Background: DevicesBackground, Settings: DevicesSettings, settingsOrder: 10 }
