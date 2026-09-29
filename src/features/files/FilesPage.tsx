import { CheckCircle2, Computer, FilePlus2, FolderOpen, FolderPlus, Play, Send, Square, Trash2, Upload, Wifi } from 'lucide-react'
import { openPath } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { updateMachine, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { fmtSize, machineIdForPlatform, shortPath } from '../../core/util'
import { Card, SectionTitle, StatusPill } from '../../ui'
import {
  addTransferPaths, answerLocalSend, clearTransferPaths, receiverStore, sendWithLocalSend, startLocalSendReceiver,
  stopLocalSendReceiver, transferBusyStore, transferPathsStore, transferStateStore,
} from './state'

export default function FilesPage() {
  const config = useConfig()
  const receiver = useStore(receiverStore)
  const transferPaths = useStore(transferPathsStore)
  const transferState = useStore(transferStateStore)
  const transferBusy = useStore(transferBusyStore)
  const localPlatform = useStore(bridgeLinkStore).platform
  return <>
    <div className="two-col files-top">
      <Card><SectionTitle title="Transfer queue" subtitle={`${transferPaths.length} selection${transferPaths.length === 1 ? '' : 's'} queued`} action={<StatusPill online label="Native core"/>} /><div className="actions"><button onClick={() => void addTransferPaths(false)}><FilePlus2 size={17}/>Choose files</button><button className="secondary" onClick={() => void addTransferPaths(true)}><FolderPlus size={17}/>Choose folder</button><button className="secondary" disabled={!transferPaths.length} onClick={clearTransferPaths}><Trash2 size={17}/>Clear</button></div><div className="transfer-list">{transferPaths.length ? transferPaths.map(path => <div key={path}><Upload size={15}/><span title={path}>{shortPath(path)}</span><small>{path}</small></div>) : <div className="bb-placeholder">Nothing queued yet.</div>}</div><p className="transfer-state">{transferState}</p></Card>
      <Card><SectionTitle title="Receive on this computer" subtitle={receiver.detail || 'BridgeDeck runs the LocalSend protocol server itself'} action={<StatusPill online={receiver.running} label={receiver.running ? 'Listening' : 'Stopped'}/>} /><div className="remote-id"><Wifi size={26}/><div><span>LocalSend identity</span><strong>{receiver.alias}:{receiver.port}</strong><small>{receiver.fingerprint ? `Fingerprint ${receiver.fingerprint.slice(0, 18)}…` : 'Identity is created when the receiver starts'}</small></div></div><div className="actions">{receiver.running ? <button onClick={() => void stopLocalSendReceiver()}><Square size={16}/>Stop receiver</button> : <button onClick={() => void startLocalSendReceiver()}><Play size={16}/>Start receiver</button>}<button className="secondary" disabled={!receiver.destination} onClick={() => void openPath(receiver.destination)}><FolderOpen size={16}/>Receive folder</button></div></Card>
    </div>

    {receiver.pending && <Card className="incoming-card"><SectionTitle title={`Incoming from ${receiver.pending.senderAlias}`} subtitle={`${receiver.pending.files.length} file${receiver.pending.files.length === 1 ? '' : 's'} · ${fmtSize(receiver.pending.totalBytes)} · ${receiver.pending.host}`} action={<StatusPill online label="Approval needed"/>} /><div className="incoming-files">{receiver.pending.files.slice(0, 8).map(file => <div key={file.id}><span>{file.name}</span><small>{fmtSize(file.size)}</small></div>)}{receiver.pending.files.length > 8 && <small>+ {receiver.pending.files.length - 8} more</small>}</div><div className="actions"><button onClick={() => void answerLocalSend(true)}><CheckCircle2 size={17}/>Accept</button><button className="secondary danger" onClick={() => void answerLocalSend(false)}><Trash2 size={17}/>Decline</button></div></Card>}

    {receiver.active && <Card><SectionTitle title={`Receiving from ${receiver.active.senderAlias}`} subtitle={`${receiver.active.filesDone}/${receiver.active.filesTotal} files`} action={<StatusPill online label="Receiving"/>} /><div className="receive-progress"><div><span style={{ width: `${Math.min(100, receiver.active.totalBytes ? (receiver.active.receivedBytes / receiver.active.totalBytes) * 100 : 0)}%` }}/></div><p>{fmtSize(receiver.active.receivedBytes)} / {fmtSize(receiver.active.totalBytes)}</p></div></Card>}

    <div className="machine-cards transfer-destinations">{config.machines.filter(machine => machine.id !== machineIdForPlatform(localPlatform)).map(machine => <Card key={machine.id}><SectionTitle title={`Send to ${machine.name}`} subtitle={machine.localsendTarget || 'Add a discovered alias or LAN IP in Settings'} action={<StatusPill online={Boolean(machine.localsendTarget)} label={machine.localsendTarget ? 'Target set' : 'Unconfigured'}/>} /><div className="transfer-target"><Computer size={24}/><div><span>Destination</span><strong>{machine.localsendTarget || '—'}</strong><small>Discovered LocalSend alias, IP, or IP:port</small></div></div><button className="send-primary" disabled={!machine.localsendTarget || !transferPaths.length || transferBusy} onClick={() => void sendWithLocalSend(machine)}><Send size={18}/>{transferBusy ? 'Transfer running…' : `Send ${transferPaths.length || ''} ${transferPaths.length === 1 ? 'selection' : 'selections'}`}</button></Card>)}</div>

    <div className="two-col">
      <Card><SectionTitle title="Discovered LocalSend devices" subtitle={`${receiver.devices.length} device${receiver.devices.length === 1 ? '' : 's'} seen`} />{receiver.devices.length ? <div className="device-discovery-list">{receiver.devices.map(device => <div key={`${device.fingerprint}-${device.host}`}><div><strong>{device.alias}</strong><small>{device.host}:{device.port} · {device.deviceModel || device.protocol}</small></div><button className="ghost" onClick={() => { const target = device.alias; const empty = config.machines.find(m => !m.localsendTarget); if (empty) updateMachine(empty.id, { localsendTarget: target }); transferStateStore.set(`Discovered target: ${target}`) }}>Use target</button></div>)}</div> : <div className="bb-placeholder">Start the receiver to advertise BridgeDeck and discover nearby LocalSend devices.</div>}</Card>
      <Card><SectionTitle title="Recent incoming" subtitle="Stored locally for this BridgeDeck session" />{receiver.recent.length ? <div className="recent-transfer-list">{receiver.recent.slice(0, 8).map(item => <div key={`${item.sessionId}-${item.finishedAt}`}><div><strong>{item.senderAlias}</strong><small>{item.message || `${item.files} file${item.files === 1 ? '' : 's'} · ${fmtSize(item.bytes)}`}</small></div><StatusPill online={item.status === 'received' || item.status === 'message'} label={item.status}/></div>)}</div> : <div className="bb-placeholder">No incoming transfers yet.</div>}</Card>
    </div>
    <div className="two-col shared-files">{config.machines.map(m => <Card key={m.id}><SectionTitle title={`${m.name} shared folder`} subtitle={m.sharedPath || 'Shared path not configured'} /><div className="actions"><button disabled={!m.sharedPath} onClick={() => void openPath(m.sharedPath)}><FolderOpen size={17}/>Open shared folder</button></div></Card>)}</div>
  </>
}
