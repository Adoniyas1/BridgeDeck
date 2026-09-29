import { setConfig, useConfig } from '../../core/config'
import { Card, SectionTitle, Toggle } from '../../ui'
import type { AppConfig } from '../../types'

export default function SyncSettings() {
  const config = useConfig()
  const patch = (next: Partial<AppConfig['syncthing']>) => setConfig(c => ({ ...c, syncthing: { ...c.syncthing, ...next } }))
  return <Card><SectionTitle title="Syncthing" subtitle="BridgeDeck can automatically add the paired device and create the shared workspace" /><label>REST base URL<input value={config.syncthing.baseUrl} onChange={e => patch({ baseUrl: e.target.value })}/></label><label>API key<input type="password" value={config.syncthing.apiKey} onChange={e => patch({ apiKey: e.target.value })}/></label><Toggle checked={config.syncthing.autoSetup} onChange={autoSetup => patch({ autoSetup })} label="Automatically configure Syncthing after BridgeLink pairing"/><div className="field-row"><label>Shared folder ID<input value={config.syncthing.sharedFolderId} onChange={e => patch({ sharedFolderId: e.target.value })} placeholder="bridgedeck-shared"/></label><label>Shared folder label<input value={config.syncthing.sharedFolderLabel} onChange={e => patch({ sharedFolderLabel: e.target.value })} placeholder="BridgeDeck Shared"/></label></div><label>Local shared folder path<input value={config.syncthing.sharedFolderPath} onChange={e => patch({ sharedFolderPath: e.target.value })} placeholder="Blank = ~/BridgeDeck Shared"/></label><p className="vendor-note">The Syncthing API key stays on this computer. BridgeLink exchanges only Syncthing device IDs, which Syncthing treats as public identifiers.</p></Card>
}
