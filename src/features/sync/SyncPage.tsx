import { useEffect } from 'react'
import { useTabAwake } from '../../core/awake'
import { AlertTriangle, ArrowLeftRight, FolderOpen, FolderPlus, Pause, Play, RefreshCw, Trash2, Wifi } from 'lucide-react'
import { openPath } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { openTab } from '../../core/tabs'
import { fmtSize, fmtUptime } from '../../core/util'
import { Card, SectionTitle, StatusPill } from '../../ui'
import {
  addFolder, adoptExisting, conflictsStore, configureSyncthingPeer, folderStatusStore, refreshSyncthing, removeFolder, scanConflicts,
  setFolderPaused, sidecarStore, startBuiltIn, syncthingFoldersStore, syncthingStore,
} from './state'

const stateLabel: Record<string, string> = { idle: 'Up to date', scanning: 'Scanning', syncing: 'Syncing', 'sync-preparing': 'Preparing', 'sync-waiting': 'Waiting', error: 'Error', unknown: '—' }
const sidecarUnavailable = import.meta.env.DEV
  ? 'Syncthing has not been built for this source checkout. In PowerShell, run npm run runtime:build (requires Go), then restart BridgeDeck.'
  : 'This installation is missing its bundled Syncthing helper. Reinstall BridgeDeck from a Release build.'

export default function SyncPage({ active }: { active: boolean }) {
  const config = useConfig()
  const syncthing = useStore(syncthingStore)
  const sidecar = useStore(sidecarStore)
  const folders = useStore(syncthingFoldersStore)
  const folderStatus = useStore(folderStatusStore)
  const conflicts = useStore(conflictsStore)
  const paired = useStore(bridgeLinkStore).paired
  const builtin = config.syncthing.mode === 'builtin'
  const shared = folders.find(folder => folder.id === config.syncthing.sharedFolderId)

  // Conflict copies are looked for while this tab is open (walking large folders isn't free).
  const awake = useTabAwake()
  useEffect(() => {
    if (!awake) return
    void scanConflicts()
    const timer = window.setInterval(() => void scanConflicts(), 60_000)
    return () => window.clearInterval(timer)
  }, [awake, folders.length])

  return <>
    <Card><SectionTitle title={builtin ? 'Syncthing (built in)' : 'Syncthing (separate app)'} subtitle={syncthing.ok ? `Device ${syncthing.myID || ''}` : builtin ? sidecar.detail || 'Starting…' : syncthing.error || 'Not connected'} action={<StatusPill online={syncthing.ok}/>} />
      <div className="sync-panel"><Wifi size={28}/><div><h3>{syncthing.ok ? 'Syncing with your paired devices' : builtin ? (sidecar.available ? 'Starting Syncthing…' : sidecarUnavailable) : 'Waiting for Syncthing'}</h3><p>Uptime {fmtUptime(syncthing.uptime)} · {folders.length} folder{folders.length === 1 ? '' : 's'}{sidecar.adoptedFrom ? ' · moved in from the separate Syncthing app' : ''}</p></div></div>
      {builtin && !sidecar.available && <p className="error-text">{sidecarUnavailable}</p>}
      <div className="actions">
        {builtin && !sidecar.running && sidecar.available && <button onClick={() => void startBuiltIn()}><Play size={16}/>Start</button>}
        <button className="secondary" onClick={() => void refreshSyncthing()}><RefreshCw size={16}/>Refresh</button>
        <button className="secondary" disabled={!syncthing.ok} onClick={() => void addFolder()}><FolderPlus size={16}/>Share a folder</button>
      </div>
    </Card>

    {sidecar.adoptable && !sidecar.adoptedFrom && <Card className="incoming-card"><SectionTitle title="Move your Syncthing into BridgeDeck" subtitle="BridgeDeck can run Syncthing for you, hidden, with the same device ID and folders" />
      <p className="pair-note">This stops the separate Syncthing app{builtin ? '' : ' (through its API)'} and copies its identity, settings and database into BridgeDeck. Your devices and shared folders keep working. Afterwards, remove the Syncthing app from your login items so it doesn't start again. Found: {sidecar.adoptable}</p>
      <div className="actions"><button onClick={() => void adoptExisting(sidecar.adoptable!)}><ArrowLeftRight size={16}/>Move into BridgeDeck</button></div>
    </Card>}

    <Card><SectionTitle title="BridgeDeck Shared" subtitle="The workspace shared with your paired computers" action={<StatusPill online={!!shared} label={shared ? 'Configured' : 'Waiting'}/>} /><p className="vendor-note">Folder ID: {config.syncthing.sharedFolderId} · Local path: {shared?.path || config.syncthing.sharedFolderPath || '~/BridgeDeck Shared'}</p><div className="actions">{paired.map(peer => <button key={peer.instanceId} className="secondary" disabled={!config.syncthing.apiKey} onClick={() => void configureSyncthingPeer(peer)}><ArrowLeftRight size={16}/>Link {peer.name}</button>)}{shared?.path && <button className="secondary" onClick={() => void openPath(shared.path!)}><FolderOpen size={16}/>Open workspace</button>}</div></Card>

    <div className="folder-grid">{folders.map(folder => {
      const status = folderStatus[folder.id] ?? {}
      const total = status.globalBytes ?? 0
      const percent = total ? Math.round(((status.inSyncBytes ?? 0) / total) * 100) : 100
      const folderConflicts = conflicts[folder.id] ?? []
      return <Card key={folder.id}><SectionTitle title={folder.label || folder.id} subtitle={folder.path || folder.id} action={<StatusPill online={!folder.paused && status.state !== 'error'} label={folder.paused ? 'Paused' : stateLabel[status.state ?? 'unknown'] ?? status.state}/>} />
        <div className="receive-progress"><div><span style={{ width: `${percent}%` }}/></div><p>{status.needBytes ? `${fmtSize(status.needBytes)} left · ${status.needFiles ?? 0} files` : `${fmtSize(total)} in sync`}</p></div>
        {!!folderConflicts.length && <p className="error-text"><AlertTriangle size={13}/> {folderConflicts.length} file{folderConflicts.length === 1 ? ' was' : 's were'} changed on two computers at once</p>}
        <div className="actions">
          {folder.path && <button className="ghost" onClick={() => void openPath(folder.path!)}><FolderOpen size={16}/>Open</button>}
          {!!folderConflicts.length && <button onClick={() => openTab({ id: `sync-conflicts:${folder.id}`, kind: 'sync-conflicts', title: `Conflicts: ${folder.label || folder.id}`, params: { folderId: folder.id, path: folder.path, label: folder.label || folder.id } })}><AlertTriangle size={16}/>Resolve</button>}
          <button className="ghost" onClick={() => void setFolderPaused(folder, !folder.paused)}>{folder.paused ? <><Play size={16}/>Resume</> : <><Pause size={16}/>Pause</>}</button>
          <button className="ghost" title="Stop syncing (files stay here)" onClick={() => void removeFolder(folder)}><Trash2 size={16}/></button>
        </div>
      </Card>
    })}</div>
  </>
}
