import { FolderOpen, MonitorUp, RefreshCw, ShieldCheck } from 'lucide-react'
import { launchApp } from '../../lib/bridge'
import { sortedDevices, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { Card, SectionTitle, StatusPill } from '../../ui'
import { refreshRustDeskIdentity, rustdeskExecutable, rustdeskInfoStore, startRustDeskSession } from './state'

export default function RemotePage() {
  const config = useConfig()
  const rustdeskInfo = useStore(rustdeskInfoStore)
  return <>
    <div className="remote-hero">
      <Card><SectionTitle title="This computer" subtitle="RustDesk identity detected by BridgeDeck" action={<StatusPill online={rustdeskInfo.available} label={rustdeskInfo.available ? 'Ready' : 'Missing'}/>} /><div className="remote-id"><MonitorUp size={28}/><div><span>RustDesk ID</span><strong>{rustdeskInfo.id || 'Not available yet'}</strong><small>{rustdeskInfo.executable || rustdeskInfo.detail || 'Build/import the RustDesk runtime or install RustDesk.'}</small></div></div><div className="actions"><button className="secondary" onClick={() => void launchApp('rustdesk', rustdeskExecutable())}>Open original RustDesk UI</button><button className="secondary" onClick={() => void refreshRustDeskIdentity()}><RefreshCw size={16}/>Refresh ID</button></div></Card>
      <Card><SectionTitle title="BridgeDeck Remote" subtitle="BridgeDeck owns peer selection and session mode" /><div className="remote-note"><ShieldCheck size={22}/><p>Control and file-transfer sessions are launched directly from this page. RustDesk still renders the remote desktop window and handles its authentication/transport.</p></div></Card>
    </div>
    <div className="machine-cards">{sortedDevices(config.devices).filter(device => !device.local).map(machine => <Card key={machine.id}><SectionTitle title={machine.name} subtitle={machine.rustdeskPeerId ? `Peer ${machine.rustdeskPeerId}` : 'Add RustDesk peer ID in Settings'} action={<StatusPill online={Boolean(machine.rustdeskPeerId && rustdeskInfo.available)} label={machine.rustdeskPeerId ? 'Paired' : 'Unpaired'}/>} /><div className="remote-actions"><button disabled={!machine.rustdeskPeerId || !rustdeskInfo.available} onClick={() => void startRustDeskSession(machine, 'control')}><MonitorUp size={18}/><span><strong>Control computer</strong><small>Interactive RustDesk desktop session</small></span></button><button disabled={!machine.rustdeskPeerId || !rustdeskInfo.available} onClick={() => void startRustDeskSession(machine, 'file-transfer')}><FolderOpen size={18}/><span><strong>RustDesk file transfer</strong><small>Use RustDesk's direct peer transfer mode</small></span></button></div></Card>)}{!config.devices.some(device => !device.local) && <div className="bb-placeholder">Pair another computer on the Computers tab to control it from here.</div>}</div>
  </>
}
