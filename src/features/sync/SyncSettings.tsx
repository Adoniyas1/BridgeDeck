import { setConfig, useConfig } from '../../core/config'
import { Card, SectionTitle, Toggle } from '../../ui'
import type { AppConfig } from '../../types'
import BackupsCard from './BackupsCard'

export default function SyncSettings() {
  const config = useConfig()
  const patch = (next: Partial<AppConfig['syncthing']>) => setConfig(c => ({ ...c, syncthing: { ...c.syncthing, ...next } }))
  const builtin = config.syncthing.mode === 'builtin'
  return <><Card><SectionTitle title="Syncthing" subtitle="Shared folders between your paired computers" />
    <Toggle checked={builtin} onChange={on => patch({ mode: on ? 'builtin' : 'external' })} label="Run Syncthing inside BridgeDeck (recommended)"/>
    {!builtin && <><label>REST base URL<input value={config.syncthing.baseUrl} onChange={e => patch({ baseUrl: e.target.value })} placeholder="http://127.0.0.1:8384"/></label><label>API key<input type="password" value={config.syncthing.apiKey} onChange={e => patch({ apiKey: e.target.value })}/></label></>}
    <Toggle checked={config.syncthing.autoSetup} onChange={autoSetup => patch({ autoSetup })} label="Share the BridgeDeck folder with paired computers automatically"/>
    <div className="field-row"><label>Shared folder ID<input value={config.syncthing.sharedFolderId} onChange={e => patch({ sharedFolderId: e.target.value })} placeholder="bridgedeck-shared"/></label><label>Shared folder label<input value={config.syncthing.sharedFolderLabel} onChange={e => patch({ sharedFolderLabel: e.target.value })} placeholder="BridgeDeck Shared"/></label></div>
    <label>Local shared folder path<input value={config.syncthing.sharedFolderPath} onChange={e => patch({ sharedFolderPath: e.target.value })} placeholder="Blank = ~/BridgeDeck Shared"/></label>
    <p className="vendor-note">{builtin ? 'BridgeDeck runs its own copy of Syncthing in the background, with its API on this computer only.' : 'The Syncthing API must be on this computer (127.0.0.1); its key never leaves it.'} BridgeLink exchanges only Syncthing device IDs.</p>
  </Card>
  <BackupsCard /></>
}
