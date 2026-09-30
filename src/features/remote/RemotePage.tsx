import { MonitorUp, MousePointer2, ShieldCheck } from 'lucide-react'
import { bridgeLinkStore } from '../../core/bridgelink'
import { setConfig, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { Card, SectionTitle, StatusPill, Toggle } from '../../ui'
import { controlDevice, hostStore, stopHosting } from './state'

const canHost = (platform: string) => platform === 'macos' || platform === 'windows'
const since = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export default function RemotePage() {
  const config = useConfig()
  const paired = useStore(bridgeLinkStore).paired
  const host = useStore(hostStore)
  const setRemote = (changes: Partial<typeof config.remote>) => setConfig(c => ({ ...c, remote: { ...c.remote, ...changes } }))

  return <>
    <div className="remote-hero">
      <Card><SectionTitle title="Control a device" subtitle="Opens its screen in a tab, over the encrypted link (LAN or Tailscale)" />
        <div className="stack">{paired.map(peer => <div className="machine-row" key={peer.instanceId}>
          <div className="machine-avatar"><MonitorUp size={18}/></div>
          <div className="grow"><strong>{peer.name}</strong><small>{canHost(peer.platform) ? `${peer.platform === 'macos' ? 'Mac' : 'Windows'} · ${peer.via === 'tailscale' ? 'Tailscale' : 'local network'}` : 'This device can’t be controlled'}</small></div>
          <button disabled={!canHost(peer.platform)} onClick={() => controlDevice({ id: peer.instanceId, name: peer.name })}><MousePointer2 size={15}/>Control</button>
        </div>)}
        {!paired.length && <div className="bb-placeholder">Pair another computer on the Devices tab to control it from here.</div>}</div>
      </Card>
      <Card><SectionTitle title="This computer" subtitle={host.supported ? 'Paired devices can see and control this screen' : 'Can control other computers; can’t be controlled (macOS and Windows only)'} action={<StatusPill online={host.supported && config.remote.allowControl} label={!host.supported ? 'View only' : config.remote.allowControl ? 'Allowed' : 'Off'}/>} />
        {host.supported && <>
          <Toggle checked={config.remote.allowControl} onChange={allowControl => setRemote({ allowControl })} label="Let my paired devices control this computer" />
          <Toggle checked={config.remote.askFirst} onChange={askFirst => setRemote({ askFirst })} label="Ask me each time" />
          <div className="remote-note"><ShieldCheck size={22}/><p>Only devices you paired can connect. While one does, a banner at the top of BridgeDeck says who, with Stop; the tray menu has Stop too.{navigator.userAgent.includes('Mac') ? ' On the Mac, allow BridgeDeck under Privacy & Security → Screen Recording and Accessibility.' : ''}</p></div>
        </>}
        {!!host.sessions.length && <div className="actions">{host.sessions.map(s => <span key={s.id} className="vendor-note">{s.peerName} since {since(s.since)}</span>)}<button className="danger" onClick={() => void stopHosting()}>Stop remote control</button></div>}
      </Card>
    </div>
  </>
}
