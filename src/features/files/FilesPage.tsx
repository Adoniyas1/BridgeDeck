import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Computer, FilePlus2, FolderOpen, FolderPlus, Play, RotateCw, Send, Smartphone, Square, Trash2, Upload, Wifi, X } from 'lucide-react'
import { useState } from 'react'
import { localSendNativeSend, openPath, transferCancel, transferResume, transfersClear } from '../../lib/bridge'
import { bridgeLinkStore, deviceStatusStore } from '../../core/bridgelink'
import { useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { fmtSize, platformLabel, shortPath } from '../../core/util'
import { Card, SectionTitle, StatusPill } from '../../ui'
import {
  addTransferPaths, answerLocalSend, clearTransferPaths, receiverStore, refreshTransfers, sendToPeer, startLocalSendReceiver,
  stopLocalSendReceiver, transfersStore, transferPathsStore, transferStateStore,
} from './state'
import { active, detail, percent, what } from './transfers'

export default function FilesPage() {
  const config = useConfig()
  const receiver = useStore(receiverStore)
  const transferPaths = useStore(transferPathsStore)
  const transferState = useStore(transferStateStore)
  const transfers = useStore(transfersStore)
  const paired = useStore(bridgeLinkStore).paired
  const online = useStore(deviceStatusStore)
  const [sendingTo, setSendingTo] = useState<string | null>(null)
  const shared = config.devices.filter(d => d.sharedPath)

  async function sendLocalSend(target: string, name: string) {
    setSendingTo(target)
    transferStateStore.set(`Sending to ${name} with LocalSend…`)
    try {
      const result = await localSendNativeSend(target, transferPaths, '')
      if (!result.ok) throw new Error(result.stderr || result.stdout || 'LocalSend transfer failed')
      transferStateStore.set(`Sent to ${name}.`)
      clearTransferPaths()
    } catch (error) {
      transferStateStore.set(error instanceof Error ? error.message : String(error))
    } finally {
      setSendingTo(null)
    }
  }

  return <>
    <div className="two-col files-top">
      <Card><SectionTitle title="Files to send" subtitle={transferPaths.length ? `${transferPaths.length} item${transferPaths.length === 1 ? '' : 's'} ready` : 'Choose them here, drop them on the window, or use Send to / Open With'} />
        <div className="actions"><button onClick={() => void addTransferPaths(false)}><FilePlus2 size={17}/>Choose files</button><button className="secondary" onClick={() => void addTransferPaths(true)}><FolderPlus size={17}/>Choose folder</button><button className="secondary" disabled={!transferPaths.length} onClick={clearTransferPaths}><Trash2 size={17}/>Clear</button></div>
        <div className="transfer-list">{transferPaths.length ? transferPaths.map(path => <div key={path}><Upload size={15}/><span title={path}>{shortPath(path)}</span><small>{path}</small></div>) : <div className="bb-placeholder">Nothing chosen yet.</div>}</div>
        <p className="transfer-state">{transferState}</p>
      </Card>
      <Card><SectionTitle title="Send to your computers" subtitle="Straight over the encrypted link (same network or Tailscale), with resume" />
        <div className="stack">{paired.length ? paired.map(peer => {
          const up = !!online[peer.instanceId]?.ok
          return <div className="machine-row" key={peer.instanceId}>
            <div className="machine-avatar"><Computer size={20}/></div>
            <div className="grow"><strong>{peer.name}</strong><small>{platformLabel(peer.platform)} · {up ? 'online' : 'offline'}</small></div>
            <button className="send-inline" disabled={!transferPaths.length} onClick={() => void sendToPeer(peer.instanceId)}><Send size={15}/>Send</button>
          </div>
        }) : <div className="bb-placeholder">Pair a computer first (Computers tab).</div>}</div>
      </Card>
    </div>

    {transfers.length > 0 && <Card className="transfers-card"><SectionTitle title="Transfers" subtitle={`${transfers.filter(active).length} running`}
      action={transfers.some(t => !active(t)) ? <button className="ghost" onClick={() => void transfersClear().then(refreshTransfers)}>Clear finished</button> : undefined} />
      <div className="transfer-rows">{transfers.map(t => <div key={`${t.direction}:${t.id}`} className={`transfer-row state-${t.state}`}>
        <div className="transfer-icon">{t.direction === 'send' ? <ArrowUpFromLine size={16}/> : <ArrowDownToLine size={16}/>}</div>
        <div className="grow">
          <div className="transfer-row-head"><strong title={t.names.join('\n')}>{what(t)}</strong><small>{t.direction === 'send' ? `to ${t.peerName}` : `from ${t.peerName}`}</small></div>
          {(active(t) || t.state === 'cancelled' || t.state === 'failed') && <div className="transfer-bar"><span style={{ width: `${percent(t)}%` }} /></div>}
          <small className="transfer-detail">{detail(t)}</small>
        </div>
        <div className="transfer-actions">
          {active(t) && <button className="ghost" title="Cancel" onClick={() => void transferCancel(t.id).then(refreshTransfers)}><X size={14}/>Cancel</button>}
          {t.canResume && <button className="ghost" title="Continue where it stopped" onClick={() => void transferResume(t.id).then(refreshTransfers).catch(e => transferStateStore.set(String(e)))}><RotateCw size={14}/>Resume</button>}
          {t.direction === 'receive' && t.state === 'done' && t.folder && <button className="ghost" onClick={() => void openPath(t.folder!)}><FolderOpen size={14}/>Show</button>}
        </div>
      </div>)}</div>
    </Card>}

    {receiver.pending && <Card className="incoming-card"><SectionTitle title={`Incoming from ${receiver.pending.senderAlias}`} subtitle={`${receiver.pending.files.length} file${receiver.pending.files.length === 1 ? '' : 's'} · ${fmtSize(receiver.pending.totalBytes)} · ${receiver.pending.host}`} action={<StatusPill online label="Approval needed"/>} /><div className="incoming-files">{receiver.pending.files.slice(0, 8).map(file => <div key={file.id}><span>{file.name}</span><small>{fmtSize(file.size)}</small></div>)}{receiver.pending.files.length > 8 && <small>+ {receiver.pending.files.length - 8} more</small>}</div><div className="actions"><button onClick={() => void answerLocalSend(true)}><CheckCircle2 size={17}/>Accept</button><button className="secondary danger" onClick={() => void answerLocalSend(false)}><Trash2 size={17}/>Decline</button></div></Card>}

    {receiver.active && <Card><SectionTitle title={`Receiving from ${receiver.active.senderAlias}`} subtitle={`${receiver.active.filesDone}/${receiver.active.filesTotal} files · LocalSend`} action={<StatusPill online label="Receiving"/>} /><div className="receive-progress"><div><span style={{ width: `${Math.min(100, receiver.active.totalBytes ? (receiver.active.receivedBytes / receiver.active.totalBytes) * 100 : 0)}%` }}/></div><p>{fmtSize(receiver.active.receivedBytes)} / {fmtSize(receiver.active.totalBytes)}</p></div></Card>}

    <div className="two-col">
      <Card><SectionTitle title="Other devices (LocalSend)" subtitle="Phones and computers running the LocalSend app" action={<StatusPill online={receiver.running} label={receiver.running ? 'Visible' : 'Hidden'}/>} />
        <div className="remote-id"><Wifi size={22}/><div><span>Visible to them as</span><strong>{receiver.alias}</strong><small>Files they send ask you first, then go to {receiver.destination || 'Downloads'}</small></div></div>
        {receiver.devices.length ? <div className="device-discovery-list">{receiver.devices.map(device => <div key={`${device.fingerprint}-${device.host}`}><Smartphone size={16}/><div className="grow"><strong>{device.alias}</strong><small>{device.deviceModel || device.protocol} · {device.host}</small></div><button className="ghost" disabled={!transferPaths.length || sendingTo !== null} onClick={() => void sendLocalSend(`${device.host}:${device.port}`, device.alias)}><Send size={14}/>{sendingTo === `${device.host}:${device.port}` ? 'Sending…' : 'Send'}</button></div>)}</div>
          : <div className="bb-placeholder">{receiver.running ? 'No LocalSend devices seen on this network yet.' : 'Turn on to see and be seen by LocalSend devices.'}</div>}
        <div className="actions">{receiver.running ? <button className="secondary" onClick={() => void stopLocalSendReceiver()}><Square size={15}/>Turn off</button> : <button onClick={() => void startLocalSendReceiver()}><Play size={15}/>Turn on</button>}<button className="secondary" disabled={!receiver.destination} onClick={() => void openPath(receiver.destination)}><FolderOpen size={15}/>Receive folder</button></div>
      </Card>
      <Card><SectionTitle title="Recent from LocalSend" subtitle="Since BridgeDeck started" />{receiver.recent.length ? <div className="recent-transfer-list">{receiver.recent.slice(0, 8).map(item => <div key={`${item.sessionId}-${item.finishedAt}`}><div><strong>{item.senderAlias}</strong><small>{item.message || `${item.files} file${item.files === 1 ? '' : 's'} · ${fmtSize(item.bytes)}`}</small></div><StatusPill online={item.status === 'received' || item.status === 'message'} label={item.status}/></div>)}</div> : <div className="bb-placeholder">Nothing received by LocalSend yet.</div>}</Card>
    </div>
    {shared.length > 0 && <div className="two-col shared-files">{shared.map(m => <Card key={m.id}><SectionTitle title={`${m.name} shared folder`} subtitle={m.sharedPath} /><div className="actions"><button onClick={() => void openPath(m.sharedPath)}><FolderOpen size={17}/>Open shared folder</button></div></Card>)}</div>}
  </>
}
