import { ArrowLeftRight, FolderOpen, RefreshCw, Wifi } from 'lucide-react'
import { openExternal, openPath } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { fmtUptime } from '../../core/util'
import { Card, SectionTitle, StatusPill } from '../../ui'
import { configureSyncthingPeer, refreshSyncthing, syncthingFoldersStore, syncthingStore } from './state'

export default function SyncPage() {
  const config = useConfig()
  const syncthing = useStore(syncthingStore)
  const folders = useStore(syncthingFoldersStore)
  const paired = useStore(bridgeLinkStore).paired
  const shared = folders.find(folder => folder.id === config.syncthing.sharedFolderId)
  return <>
    <Card><SectionTitle title="Syncthing" subtitle={syncthing.ok ? `Device ${syncthing.myID || ''}` : syncthing.error || 'Not connected'} action={<StatusPill online={syncthing.ok}/>} /><div className="sync-panel"><Wifi size={28}/><div><h3>{syncthing.ok ? 'Syncthing API connected' : 'Waiting for Syncthing'}</h3><p>Uptime {fmtUptime(syncthing.uptime)} · {folders.length} configured folders</p></div></div><div className="actions"><button onClick={() => void openExternal(config.syncthing.baseUrl)}><Wifi size={17}/>Open Syncthing UI</button><button className="secondary" onClick={() => void refreshSyncthing()}><RefreshCw size={17}/>Refresh</button></div></Card>
    <Card><SectionTitle title="BridgeDeck Shared" subtitle="Automatic Syncthing workspace for paired computers" action={<StatusPill online={!!shared} label={shared ? 'Configured' : 'Waiting'}/>} /><p className="vendor-note">Folder ID: {config.syncthing.sharedFolderId} · Local path: {shared?.path || config.syncthing.sharedFolderPath || '~/BridgeDeck Shared'}</p><div className="actions">{paired.map(peer => <button key={peer.instanceId} className="secondary" disabled={!config.syncthing.apiKey} onClick={() => void configureSyncthingPeer(peer)}><ArrowLeftRight size={16}/>Link {peer.name}</button>)}{shared?.path && <button className="secondary" onClick={() => void openPath(shared.path!)}><FolderOpen size={16}/>Open workspace</button>}</div></Card>
    <div className="folder-grid">{folders.map(folder => <Card key={folder.id}><SectionTitle title={folder.label || folder.id} subtitle={folder.path || folder.id} action={<StatusPill online={!folder.paused} label={folder.paused ? 'Paused' : 'Active'}/>} /><p className="vendor-note">Type: {folder.type || 'sendreceive'}</p>{folder.path && <button className="ghost" onClick={() => void openPath(folder.path!)}><FolderOpen size={16}/>Open folder</button>}</Card>)}</div>
  </>
}
