import { ArrowLeftRight, Computer, Home, MessageSquare, MonitorUp, ServerCog, Upload } from 'lucide-react'
import { machineStatusStore } from '../../core/bridgelink'
import { useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle, StatusPill } from '../../ui'
import type { FeatureManifest } from '../features'
import { receiverStore } from '../files/state'
import { rustdeskInfoStore, startRustDeskSession } from '../remote/state'
import { serviceIds, useServiceReady } from '../services/state'

function HomePage() {
  const config = useConfig()
  const machineStatus = useStore(machineStatusStore)
  const rustdeskInfo = useStore(rustdeskInfoStore)
  const receiver = useStore(receiverStore)
  const ready = useServiceReady()
  const onlineMachines = Object.values(machineStatus).filter(s => s.ok).length
  const activeServices = serviceIds.filter(id => ready[id]).length
  return <>
    <div className="hero-grid">
      <Card><div className="metric-icon"><Computer /></div><div className="metric"><span>Computers online</span><strong>{onlineMachines}<small>/ {config.machines.length}</small></strong></div></Card>
      <Card><div className="metric-icon"><ServerCog /></div><div className="metric"><span>Services ready</span><strong>{activeServices}<small>/ {serviceIds.length}</small></strong></div></Card>
      <Card><div className="metric-icon"><ArrowLeftRight /></div><div className="metric"><span>Bridge state</span><strong className="metric-word">{onlineMachines ? 'Connected' : 'Waiting'}</strong></div></Card>
    </div>
    <div className="two-col">
      <Card><SectionTitle title="Computers" subtitle="BridgeLink/agent health and one-click remote control" />
        <div className="stack">{config.machines.map(m => <div className="machine-row" key={m.id}><div className="machine-avatar"><Computer size={22}/></div><div className="grow"><strong>{m.name}</strong><small>{machineStatus[m.id]?.hostname || m.agentUrl}</small></div><StatusPill online={!!machineStatus[m.id]?.ok}/><button className="ghost" disabled={!m.rustdeskPeerId} onClick={() => void startRustDeskSession(m, 'control')}>Control</button></div>)}</div>
      </Card>
      <Card><SectionTitle title="Native workflows" subtitle="Routine actions stay inside BridgeDeck" />
        <div className="stack compact"><div className="service-row"><span className="service-dot" data-on={rustdeskInfo.available}/><div className="grow"><strong>Remote</strong><small>{rustdeskInfo.available ? `RustDesk ${rustdeskInfo.id ? `ID ${rustdeskInfo.id}` : 'runtime ready'}` : 'RustDesk runtime not found'}</small></div><StatusPill online={rustdeskInfo.available} label={rustdeskInfo.available ? 'Ready' : 'Setup'}/></div><div className="service-row"><span className="service-dot" data-on={receiver.running}/><div className="grow"><strong>Files</strong><small>{receiver.running ? `Receiving as ${receiver.alias}:${receiver.port}` : 'Native LocalSend core ready; receiver stopped'}</small></div><StatusPill online={receiver.running} label={receiver.running ? 'Receiving' : 'Stopped'}/></div></div>
      </Card>
    </div>
    <Card><SectionTitle title="Quick actions" /><div className="actions"><button onClick={() => activateTab('remote')}><MonitorUp size={18}/>Remote</button><button onClick={() => activateTab('files')}><Upload size={18}/>Send files</button><button onClick={() => activateTab('messages')}><MessageSquare size={18}/>Messages</button><button className="secondary" onClick={() => activateTab('services')}><ServerCog size={18}/>Manage services</button></div></Card>
  </>
}

export const home: FeatureManifest = { id: 'home', title: 'Home', icon: Home, Page: HomePage }
