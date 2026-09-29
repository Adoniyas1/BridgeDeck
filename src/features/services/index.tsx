import { Play, ServerCog, Square, Upload } from 'lucide-react'
import { launchApp, openExternal } from '../../lib/bridge'
import { updateService, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle, StatusPill, Toggle } from '../../ui'
import { vendorPins } from '../../vendor'
import type { FeatureManifest } from '../features'
import { managedStore, ServicesBackground, startService, stopService, useServiceReady } from './state'

function ServicesPage() {
  const config = useConfig()
  const managedState = useStore(managedStore)
  const ready = useServiceReady()
  return <>
    <Card className="service-summary"><SectionTitle title="Managed runtime" subtitle="BridgeDeck only stops processes that it started itself." /><p className="vendor-note">RustDesk, Syncthing and BlueBubbles can use bundled runtimes. LocalSend send/receive now runs directly through the vendored Rust core inside BridgeDeck.</p></Card>
    <div className="services-grid">{config.services.map(service => { const pin = vendorPins.find(v => v.id === service.id); const managed = managedState[service.id]; return <Card key={service.id}><div className="service-head"><div className="service-icon"><ServerCog size={20}/></div><div className="grow"><h3>{service.name}</h3><p>{service.notes}</p></div><StatusPill online={!!ready[service.id]} label={managed?.running ? 'Managed' : ready[service.id] ? 'Ready' : 'Offline'}/></div><div className="service-meta"><span>{pin?.version || 'BridgeDeck native'}</span><span>{pin?.license || '—'}</span></div><p className="runtime-line">Runtime: {managed?.executableReady ? 'executable ready' : service.id === 'localsend' ? 'integrated Rust core' : 'set executable path or import runtime'}</p><div className="actions">{service.id !== 'localsend' && <>{managed?.running ? <button onClick={() => void stopService(service)}><Square size={16}/>Stop</button> : <button disabled={!managed?.executableReady} onClick={() => void startService(service)}><Play size={16}/>Start</button>}<button className="secondary" onClick={() => void launchApp(service.id, service.executable)}>Open</button></>}{service.id === 'localsend' && <button onClick={() => activateTab('files')}><Upload size={16}/>Open Files</button>} {service.webUrl && <button className="secondary" onClick={() => void openExternal(service.webUrl!)}>Web UI</button>}</div>{managed?.detail && <p className="vendor-note">{managed.detail}</p>}</Card> })}</div>
  </>
}

function ServicesSettings() {
  const config = useConfig()
  return <Card><SectionTitle title="Service manager" subtitle="One set of controls for BridgeDeck runtimes" />{config.services.map(service => <div className="settings-block" key={service.id}><div className="settings-heading"><h3>{service.name}</h3><div className="toggle-cluster"><Toggle checked={service.enabled} onChange={enabled => updateService(service.id, { enabled })} label="Enabled"/><Toggle checked={service.autoStart} onChange={autoStart => updateService(service.id, { autoStart })} label="Auto-start"/></div></div>{service.id !== 'localsend' && <label>Direct runtime executable<input value={service.executable || ''} onChange={e => updateService(service.id, { executable: e.target.value })} placeholder="/path/to/built/runtime"/></label>}{service.host !== undefined && <div className="field-row"><label>Health host<input value={service.host || ''} onChange={e => updateService(service.id, { host: e.target.value })}/></label><label>Port<input type="number" value={service.port || ''} onChange={e => updateService(service.id, { port: Number(e.target.value) || undefined })}/></label></div>}</div>)}</Card>
}

export const services: FeatureManifest = { id: 'services', title: 'Services', icon: ServerCog, Page: ServicesPage, Background: ServicesBackground, Settings: ServicesSettings, settingsOrder: 40 }
