import { setConfig, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { sendToStore } from './state'
import { Card, SectionTitle, Toggle } from '../../ui'
import type { AppConfig } from '../../types'

export default function FilesSettings() {
  const config = useConfig()
  const sendTo = useStore(sendToStore)
  const patch = (next: Partial<AppConfig['localsend']>) => setConfig(c => ({ ...c, localsend: { ...c.localsend, ...next } }))
  return <>{sendTo.kind && <Card><SectionTitle title={sendTo.kind === 'send-to' ? 'Send to menu' : 'Open With'} subtitle={sendTo.kind === 'send-to' ? 'Right-click files in Explorer → Send to → BridgeDeck' : 'Right-click files in Finder → Open With → BridgeDeck, or drop them on BridgeDeck in the Dock'} />{sendTo.kind === 'send-to' && <Toggle checked={config.sendTo.enabled} onChange={enabled => setConfig(c => ({ ...c, sendTo: { enabled } }))} label="Show BridgeDeck in Explorer’s Send to menu"/>}{sendTo.error && <p className="error-text">{sendTo.error}</p>}<p className="vendor-note">The files open in the Files tab; pick the computer to send them to.{sendTo.kind === 'open-with' ? ' This works in the installed app (not while running from source).' : ''}</p></Card>}<Card><SectionTitle title="Native LocalSend" subtitle="BridgeDeck uses vendor/localsend/packages/core directly" /><label>Device alias<input value={config.localsend.alias} onChange={e => patch({ alias: e.target.value })} placeholder="BridgeDeck"/></label><label>Receive folder<input value={config.localsend.destination} onChange={e => patch({ destination: e.target.value })} placeholder="Blank = system Downloads folder"/></label><div className="field-row"><label>Port<input type="number" value={config.localsend.port} onChange={e => patch({ port: Number(e.target.value) || 53317 })}/></label><label>Optional PIN<input type="password" value={config.localsend.pin} onChange={e => patch({ pin: e.target.value })}/></label></div><Toggle checked={config.localsend.autoAccept} onChange={autoAccept => patch({ autoAccept })} label="Auto-accept incoming transfers"/><p className="vendor-note">Manual approval is the default. If auto-accept is enabled, any sender that can reach this LocalSend endpoint can transfer files unless a PIN is set.</p></Card></>
}
