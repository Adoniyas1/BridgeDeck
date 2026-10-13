import { ShieldCheck } from 'lucide-react'
import { bridgeLinkStore } from '../../core/bridgelink'
import { setConfig, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { Card, SectionTitle, StatusPill, Toggle } from '../../ui'
import { hostStore, stopHosting } from './state'

const since = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Remote control of this computer: whether paired devices may control it, and the sessions now. Part of the
 *  Computers page (each computer's card there has Control for the other direction). */
export function RemoteHostCard() {
  const config = useConfig()
  const paired = useStore(bridgeLinkStore).paired
  const host = useStore(hostStore)
  const setRemote = (changes: Partial<typeof config.remote>) => setConfig(c => ({ ...c, remote: { ...c.remote, ...changes } }))

  return <Card><SectionTitle title="Remote control of this computer" subtitle={host.supported ? 'Paired devices can see and control this screen' : 'Can control other computers; can’t be controlled (macOS and Windows only)'} action={<StatusPill online={host.supported && config.remote.allowControl} label={!host.supported ? 'View only' : config.remote.allowControl ? 'Allowed' : 'Off'}/>} />
    {host.supported && <>
      <Toggle checked={config.remote.allowControl} onChange={allowControl => setRemote({ allowControl })} label="Let my paired devices control this computer" />
      <Toggle checked={config.remote.askFirst} onChange={askFirst => setRemote({ askFirst })} label="Ask me each time" />
      {!config.remote.askFirst && paired.map(peer => <Toggle key={peer.instanceId} checked={config.remote.askDevices.includes(peer.instanceId)} onChange={ask => setRemote({ askDevices: ask ? [...config.remote.askDevices, peer.instanceId] : config.remote.askDevices.filter(id => id !== peer.instanceId) })} label={`Ask me each time ${peer.name} connects`} />)}
      <div className="remote-note"><ShieldCheck size={18}/><p>Only devices you paired can connect. While one does, a banner at the top of BridgeDeck says who, with Stop; the tray menu has Stop too, and so does {navigator.userAgent.includes('Mac') ? '⌘⌥⇧S' : 'Ctrl+Alt+Shift+S'} on this keyboard.{navigator.userAgent.includes('Mac') ? ' On the Mac, allow BridgeDeck under Privacy & Security → Screen Recording and Accessibility.' : ''}</p></div>
    </>}
    {!!host.sessions.length && <div className="actions">{host.sessions.map(s => <span key={s.id} className="hint">{s.peerName} since {since(s.since)}</span>)}<button className="danger" onClick={() => void stopHosting()}>Stop remote control</button></div>}
  </Card>
}

export default RemoteHostCard
