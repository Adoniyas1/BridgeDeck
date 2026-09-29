import { useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import {
  Activity, ArrowLeftRight, Bot, CheckCircle2, Computer, FilePlus2, FolderOpen, FolderPlus,
  Gauge, HardDrive, MessageSquare, MonitorUp, Play, RefreshCw, Send, ServerCog, Settings2,
  ShieldCheck, Square, TerminalSquare, Trash2, Upload, Wifi,
} from 'lucide-react'
import Messages from './components/Messages'
import Sidebar from './components/Sidebar'
import StatusPill from './components/StatusPill'
import { defaultConfig, loadConfig, saveConfig } from './lib/config'
import {
  appAvailable, blueBubblesEnsureRunning, blueBubblesLocalPort, blueBubblesPing,
  bridgeLinkAiMessages, bridgeLinkAiSend, bridgeLinkAiTokenPath, bridgeLinkApprove, bridgeLinkDecline, bridgeLinkForget, bridgeLinkPollPair, bridgeLinkRefreshPeer, bridgeLinkRequestPair, bridgeLinkStart, bridgeLinkStatus, bridgeLinkStop,
  connectRustDesk, fetchAgent, launchApp, localSendAccept, localSendDecline, localSendNativeSend,
  localSendReceiverStart, localSendReceiverStatus, localSendReceiverStop, localSendSetTrustedHosts, rustDeskEnsureRunning, sourceUpdateStatus, managedServiceStart,
  managedServiceStatus, managedServiceStop, openExternal, openPath,
  pickTransferPaths, probeTcp, rustDeskIdentity, syncthingFolders, syncthingSetupPeer, syncthingStatus,
} from './lib/bridge'
import type {
  AgentStatus, AiRelayMessage, AppConfig, SourceUpdateStatus, BridgeLinkPairedPeer, BridgeLinkPeer, BridgeLinkStatus, LocalSendReceiverStatus, MachineConfig,
  ManagedServiceState, PageKey, RustDeskIdentity, ServiceConfig, ServiceKey,
  SyncthingAutoSetupResult, SyncthingFolder, SyncthingStatus,
} from './types'
import { vendorPins } from './vendor'

const fmtBytes = (value?: number) => value ? `${(value / 1024 ** 3).toFixed(1)} GB` : '—'
const fmtUptime = (value?: number) => value ? `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m` : '—'
const fmtSize = (value = 0) => value < 1000 ? `${value} B` : value < 1_000_000 ? `${(value / 1000).toFixed(1)} KB` : value < 1_000_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${(value / 1_000_000_000).toFixed(2)} GB`
const serviceIds: ServiceKey[] = ['rustdesk', 'bluebubbles', 'syncthing', 'localsend']
const shortPath = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
const agentUrlFor = (host: string, port: number) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`
/** True when `saved` points at a private LAN IPv4 on the same port as `current` but another host, i.e. the
 *  peer moved to a new DHCP address. Hand-entered hostnames and other ports are left alone. */
const isStaleLanUrl = (saved: string, current: string) => {
  try {
    const a = new URL(saved), b = new URL(current)
    return a.port === b.port && a.hostname !== b.hostname && /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(a.hostname)
  } catch { return false }
}
/** Native (Tauri) command errors arrive as plain strings, not Error objects. */
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === 'string' && error ? error : fallback
const machineIdForPlatform =(platform: string): MachineConfig['id'] | null => { const value = platform.toLowerCase(); if (value.includes('win')) return 'windows'; if (value.includes('mac') || value.includes('darwin')) return 'mac'; return null }

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}

function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return <label className="toggle-row"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span>{label}</span></label>
}

export default function App() {
  const [page, setPage] = useState<PageKey>('home')
  const [config, setConfig] = useState<AppConfig>(defaultConfig)
  const [hydrated, setHydrated] = useState(false)
  const [machineStatus, setMachineStatus] = useState<Record<string, AgentStatus>>({})
  const [serviceStatus, setServiceStatus] = useState<Record<string, boolean>>({})
  const [managedState, setManagedState] = useState<Record<string, ManagedServiceState>>({})
  const [syncthing, setSyncthing] = useState<SyncthingStatus>({ ok: false })
  const [syncthingFolderList, setSyncthingFolderList] = useState<SyncthingFolder[]>([])
  const [aiFeed, setAiFeed] = useState<AiRelayMessage[]>([])
  const [aiText, setAiText] = useState('')
  const [aiState, setAiState] = useState('')
  const [aiTokenPath, setAiTokenPath] = useState('')
  const [messagesUnread, setMessagesUnread] = useState(0)
  const [sourceUpdate, setSourceUpdate] = useState<SourceUpdateStatus | null>(null)
  const [rustdeskInfo, setRustdeskInfo] = useState<RustDeskIdentity>({ available: false })
  const [localsendReceiver, setLocalsendReceiver] = useState<LocalSendReceiverStatus>({ running: false, alias: 'BridgeDeck', port: 53317, destination: '', recent: [], devices: [] })
  const [transferPaths, setTransferPaths] = useState<string[]>([])
  const [transferState, setTransferState] = useState('Choose files or a folder, then select a destination.')
  const [transferBusy, setTransferBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [bridgeLink, setBridgeLink] = useState<BridgeLinkStatus>({ running: false, instanceId: '', displayName: 'BridgeDeck', platform: '', apiPort: 41416, discovered: [], pending: [], paired: [] })
  const [pairingState, setPairingState] = useState('Automatic pairing has not started yet.')
  const [syncthingSetup, setSyncthingSetup] = useState<Record<string, SyncthingAutoSetupResult | { error: string }>>({})
  const autoStarted = useRef(false)
  const pairPollBusy = useRef(false)

  useEffect(() => {
    loadConfig().then(next => { setConfig(next); setHydrated(true) })
  }, [])

  useEffect(() => {
    if (!hydrated) return
    void saveConfig(config)
  }, [config, hydrated])

  async function refresh() {
    const statuses = await Promise.all(config.machines.map(async m => [m.id, await fetchAgent(m.agentUrl, m.agentToken)] as const))
    setMachineStatus(Object.fromEntries(statuses))
    try { setSourceUpdate(await sourceUpdateStatus()) } catch { /* browser mode */ }

    // Pick up peer changes made after pairing (new IP, RustDesk/Syncthing IDs).
    try {
      const link = await bridgeLinkStatus()
      for (const peer of link.paired) {
        try {
          const refreshed = await bridgeLinkRefreshPeer(peer.instanceId)
          if (refreshed.peer) syncPairedPeer(refreshed.peer)
        } catch { /* peer offline */ }
      }
    } catch { /* browser mode */ }

    const managedPairs = await Promise.all(config.services.map(async s => [s.id, await managedServiceStatus(s.id, s.executable)] as const))
    setManagedState(Object.fromEntries(managedPairs))

    const next: Record<string, boolean> = {}
    for (const service of config.services) {
      if (!service.enabled) { next[service.id] = false; continue }
      try {
        if (service.id === 'bluebubbles' && config.bluebubbles.baseUrl && config.bluebubbles.password) {
          next[service.id] = await blueBubblesPing(config.bluebubbles.baseUrl, config.bluebubbles.password)
        } else if (service.id === 'syncthing') {
          const status = await syncthingStatus(config.syncthing.baseUrl, config.syncthing.apiKey)
          setSyncthing(status)
          next[service.id] = status.ok || (!!service.host && !!service.port && await probeTcp(service.host, service.port))
        } else if (service.host && service.port) {
          next[service.id] = await probeTcp(service.host, service.port)
        } else {
          next[service.id] = await appAvailable(service.id, service.executable)
        }
      } catch {
        next[service.id] = false
      }
    }
    setServiceStatus(next)

    if (config.syncthing.apiKey && config.syncthing.baseUrl) {
      try { setSyncthingFolderList(await syncthingFolders(config.syncthing.baseUrl, config.syncthing.apiKey)) } catch { setSyncthingFolderList([]) }
    }

    const rustdeskService = config.services.find(s => s.id === 'rustdesk')
    const rustdeskExe = rustdeskService?.executable
    // RustDesk runs whenever BridgeDeck does, so the paired computer can always connect.
    if (rustdeskService?.enabled) {
      try {
        const ensured = await rustDeskEnsureRunning(rustdeskExe)
        if (ensured.started) setNotice('Started RustDesk in the background so this computer can be controlled.')
      } catch { /* browser mode */ }
    }
    try { setRustdeskInfo(await rustDeskIdentity(rustdeskExe)) } catch { setRustdeskInfo({ available: false }) }
    // On the Mac, keep BlueBubbles Server up for the Windows Messages page (no-op on Windows).
    if (config.services.find(s => s.id === 'bluebubbles')?.enabled) {
      try { await blueBubblesEnsureRunning() } catch { /* browser mode */ }
    }
    // The computer that hosts BlueBubbles talks to it over loopback, never a LAN IP that DHCP can change.
    try {
      const localPort = await blueBubblesLocalPort()
      if (localPort) {
        const local = `http://127.0.0.1:${localPort}`
        setConfig(c => {
          const saved = c.bluebubbles.baseUrl
          const replace = !saved || (saved !== local && isStaleLanUrl(saved, local))
          return replace ? { ...c, bluebubbles: { ...c.bluebubbles, baseUrl: local } } : c
        })
      }
    } catch { /* browser mode */ }
    try {
      const receiver = await localSendReceiverStatus()
      setLocalsendReceiver(receiver)
      next.localsend = receiver.running
      setServiceStatus({ ...next, localsend: receiver.running })
    } catch { /* browser mode */ }
  }

  useEffect(() => {
    if (!hydrated) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => window.clearInterval(timer)
  }, [hydrated, config.machines, config.services, config.bluebubbles, config.syncthing, config.localsend])

  useEffect(() => {
    if (!hydrated) return
    const poll = async () => {
      try {
        const status = await localSendReceiverStatus()
        setLocalsendReceiver(status)
        setServiceStatus(current => ({ ...current, localsend: status.running }))
      } catch { /* browser mode */ }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1200)
    return () => window.clearInterval(timer)
  }, [hydrated])

  useEffect(() => {
    if (!hydrated) return
    if (config.pairing.autoStart) void startAutomaticPairing()
    else void bridgeLinkStop().then(setBridgeLink).catch(() => undefined)
  }, [hydrated, config.pairing.autoStart])

  useEffect(() => {
    if (!hydrated) return
    const poll = async () => {
      try {
        const status = await bridgeLinkStatus()
        setBridgeLink(status)
        if (status.outgoing && !pairPollBusy.current) {
          pairPollBusy.current = true
          try {
            const result = await bridgeLinkPollPair()
            if (result.paired && result.peer) {
              applyPairedPeer(result.peer)
              setNotice(`Paired with ${result.peer.name}. RustDesk, LocalSend, and machine-status settings were filled automatically.`)
              setPairingState(result.detail)
              setBridgeLink(await bridgeLinkStatus())
            } else {
              setPairingState(result.detail)
            }
          } finally {
            pairPollBusy.current = false
          }
        }
      } catch { /* browser mode or pairing service stopped */ }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1400)
    return () => window.clearInterval(timer)
  }, [hydrated])

  useEffect(() => {
    if (!hydrated || !bridgeLink.running || !syncthing.myID) return
    void bridgeLinkStart(config.pairing.displayName, config.pairing.apiPort, rustdeskInfo.id || '', config.localsend.port, syncthing.myID)
      .then(setBridgeLink)
      .catch(() => undefined)
  }, [hydrated, syncthing.myID])

  useEffect(() => {
    if (!hydrated || !config.syncthing.autoSetup || !config.syncthing.apiKey.trim() || !syncthing.ok || !bridgeLink.paired.length) return
    bridgeLink.paired.forEach(peer => {
      if (!syncthingSetup[peer.instanceId]) void configureSyncthingPeer(peer)
    })
  }, [hydrated, config.syncthing.autoSetup, config.syncthing.apiKey, syncthing.ok, bridgeLink.paired.length])

  // Dropping files anywhere on the window queues them for sending.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let unlisten: (() => void) | undefined
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type !== 'drop' || !event.payload.paths.length) return
      const dropped = event.payload.paths
      setTransferPaths(current => Array.from(new Set([...current, ...dropped])))
      setTransferState(`${dropped.length} item${dropped.length === 1 ? '' : 's'} dropped. Pick a computer to send to.`)
      setPage('files')
    }).then(fn => { unlisten = fn })
    return () => unlisten?.()
  }, [])

  // Files from paired computers are accepted without a prompt; everyone else still needs approval.
  const pairedHosts = bridgeLink.paired.map(peer => peer.host).sort().join(',')
  useEffect(() => {
    if (!hydrated) return
    void localSendSetTrustedHosts(pairedHosts ? pairedHosts.split(',') : []).catch(() => undefined)
  }, [hydrated, pairedHosts, localsendReceiver.running])

  useEffect(() => {
    if (!hydrated || autoStarted.current) return
    autoStarted.current = true
    const targets = config.services.filter(s => s.enabled && s.autoStart && s.id !== 'localsend')
    const localSendService = config.services.find(s => s.id === 'localsend')
    void Promise.all([
      ...targets.map(async s => { try { await managedServiceStart(s.id, s.executable) } catch { /* surfaced on Services */ } }),
      (async () => {
        // Receiving always starts with the app so the paired computer can send without setup.
        if (localSendService?.enabled) {
          try { setLocalsendReceiver(await localSendReceiverStart(config.localsend)) } catch { /* surfaced on Files */ }
        }
      })(),
    ]).then(() => refresh())
  }, [hydrated])

  const onlineMachines = useMemo(() => Object.values(machineStatus).filter(s => s.ok).length, [machineStatus])
  const activeServices = useMemo(() => serviceIds.filter(id => serviceStatus[id] || managedState[id]?.running).length, [serviceStatus, managedState])
  const rustdeskExe = config.services.find(s => s.id === 'rustdesk')?.executable

  function updateMachine(id: MachineConfig['id'], patch: Partial<MachineConfig>) {
    setConfig(c => ({ ...c, machines: c.machines.map(m => m.id === id ? { ...m, ...patch } : m) }))
  }

  function updateService(id: ServiceConfig['id'], patch: Partial<ServiceConfig>) {
    setConfig(c => ({ ...c, services: c.services.map(s => s.id === id ? { ...s, ...patch } : s) }))
  }

  function applyLocalBridge(status: BridgeLinkStatus, rustdeskId?: string, syncthingDeviceId?: string) {
    const machineId = machineIdForPlatform(status.platform)
    if (!machineId) return
    setConfig(c => ({
      ...c,
      machines: c.machines.map(machine => machine.id === machineId ? {
        ...machine,
        agentUrl: `http://127.0.0.1:${status.apiPort}`,
        agentToken: '',
        rustdeskPeerId: rustdeskId || machine.rustdeskPeerId,
        localsendTarget: `127.0.0.1:${c.localsend.port}`,
        bridgeInstanceId: status.instanceId,
        syncthingDeviceId: syncthingDeviceId || machine.syncthingDeviceId,
      } : machine),
    }))
  }

  function applyPairedPeer(peer: BridgeLinkPairedPeer, configureSync = true) {
    const machineId = machineIdForPlatform(peer.platform)
    if (!machineId) {
      setNotice(`Paired with ${peer.name}, but BridgeDeck does not have a ${peer.platform} machine slot yet.`)
      return
    }
    setConfig(c => ({
      ...c,
      machines: c.machines.map(machine => machine.id === machineId ? {
        ...machine,
        name: machine.id === 'mac' ? 'Mac' : 'Windows',
        agentUrl: agentUrlFor(peer.host, peer.apiPort),
        agentToken: peer.accessToken,
        rustdeskPeerId: peer.rustdeskPeerId || machine.rustdeskPeerId,
        localsendTarget: peer.localsendTarget || machine.localsendTarget,
        bridgeInstanceId: peer.instanceId,
        syncthingDeviceId: peer.syncthingDeviceId || machine.syncthingDeviceId,
      } : machine),
    }))
    if (configureSync && config.syncthing.autoSetup) void configureSyncthingPeer(peer)
  }

  /** Like applyPairedPeer, but leaves config untouched when nothing changed (it runs on every refresh). */
  function syncPairedPeer(peer: BridgeLinkPairedPeer) {
    const machineId = machineIdForPlatform(peer.platform)
    if (!machineId) return
    setConfig(c => {
      const machine = c.machines.find(m => m.id === machineId)
      if (!machine || (machine.bridgeInstanceId && machine.bridgeInstanceId !== peer.instanceId)) return c
      const next: Partial<MachineConfig> = {
        agentUrl: agentUrlFor(peer.host, peer.apiPort),
        agentToken: peer.accessToken,
        rustdeskPeerId: peer.rustdeskPeerId || machine.rustdeskPeerId,
        localsendTarget: peer.localsendTarget || machine.localsendTarget,
        syncthingDeviceId: peer.syncthingDeviceId || machine.syncthingDeviceId,
      }
      // The Mac advertises BlueBubbles Server's URL (never its password). Fill it in when unset, and follow
      // the Mac to a new DHCP address when the saved URL is a LAN IP on the same port.
      const bluebubblesUrl = peer.bluebubblesUrl && c.bluebubbles.baseUrl !== peer.bluebubblesUrl
        && (!c.bluebubbles.baseUrl || isStaleLanUrl(c.bluebubbles.baseUrl, peer.bluebubblesUrl)) ? peer.bluebubblesUrl : ''
      if (!bluebubblesUrl && Object.entries(next).every(([key, value]) => machine[key as keyof MachineConfig] === value)) return c
      return {
        ...c,
        machines: c.machines.map(m => m.id === machineId ? { ...m, ...next } : m),
        bluebubbles: bluebubblesUrl ? { ...c.bluebubbles, baseUrl: bluebubblesUrl } : c.bluebubbles,
      }
    })
  }

  async function configureSyncthingPeer(originalPeer: BridgeLinkPairedPeer) {
    if (!config.syncthing.autoSetup) return
    if (!config.syncthing.apiKey.trim()) {
      setSyncthingSetup(current => ({ ...current, [originalPeer.instanceId]: { error: 'Add the local Syncthing API key in Settings to enable automatic shared-folder setup.' } }))
      return
    }
    let peer = originalPeer
    try {
      if (!peer.syncthingDeviceId) {
        const refreshed = await bridgeLinkRefreshPeer(peer.instanceId)
        if (refreshed.peer) {
          peer = refreshed.peer
          applyPairedPeer(peer, false)
          setBridgeLink(await bridgeLinkStatus())
        }
      }
      if (!peer.syncthingDeviceId) throw new Error('The paired computer has not reported a Syncthing device ID yet. Make sure Syncthing is running there, then use Setup sync again.')
      setSyncthingSetup(current => ({ ...current, [peer.instanceId]: { error: 'Configuring Syncthing…' } }))
      const result = await syncthingSetupPeer({
        baseUrl: config.syncthing.baseUrl,
        apiKey: config.syncthing.apiKey,
        peerDeviceId: peer.syncthingDeviceId,
        peerName: peer.name,
        folderId: config.syncthing.sharedFolderId,
        folderLabel: config.syncthing.sharedFolderLabel,
        folderPath: config.syncthing.sharedFolderPath,
      })
      setSyncthingSetup(current => ({ ...current, [peer.instanceId]: result }))
      const machineId = machineIdForPlatform(peer.platform)
      if (machineId) {
        setConfig(c => ({ ...c, machines: c.machines.map(machine => machine.id === machineId ? { ...machine, syncthingDeviceId: peer.syncthingDeviceId || machine.syncthingDeviceId, sharedPath: result.folderPath } : machine) }))
      }
      setSyncthingFolderList(await syncthingFolders(config.syncthing.baseUrl, config.syncthing.apiKey))
      setNotice(result.detail)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Automatic Syncthing setup failed'
      setSyncthingSetup(current => ({ ...current, [originalPeer.instanceId]: { error: message } }))
      setNotice(message)
    }
  }

  async function startAutomaticPairing() {
    try {
      setPairingState('Starting LAN discovery…')
      // No stop/start here: BridgeLink is already running from process start, and bridgeLinkStart only
      // refreshes what it advertises (it rebinds natively if the API port changed).
      const rustdeskExe = config.services.find(s => s.id === 'rustdesk')?.executable
      const identity = await rustDeskIdentity(rustdeskExe)
      if (identity.available) setRustdeskInfo(identity)
      let localSyncthingId = ''
      if (config.syncthing.apiKey.trim()) {
        try {
          const localSync = await syncthingStatus(config.syncthing.baseUrl, config.syncthing.apiKey)
          setSyncthing(localSync)
          localSyncthingId = localSync.myID || ''
        } catch { /* Syncthing can be configured later */ }
      }
      const status = await bridgeLinkStart(config.pairing.displayName, config.pairing.apiPort, identity.id || '', config.localsend.port, localSyncthingId)
      setBridgeLink(status)
      status.paired.forEach(peer => applyPairedPeer(peer))
      applyLocalBridge(status, identity.id, localSyncthingId)
      setPairingState(status.detail || 'Automatic pairing is active.')
    } catch (error) {
      setPairingState(error instanceof Error ? error.message : 'Could not start automatic pairing')
    }
  }

  async function requestAutomaticPair(peer: BridgeLinkPeer) {
    try {
      const status = await bridgeLinkRequestPair(peer.instanceId)
      setBridgeLink(status)
      setPairingState(`Pair request sent to ${peer.name}. Confirm code ${status.outgoing?.pairingCode || 'shown on both computers'}.`)
    } catch (error) {
      setPairingState(error instanceof Error ? error.message : 'Could not request pairing')
    }
  }

  async function approveAutomaticPair(requestId: string) {
    try {
      const result = await bridgeLinkApprove(requestId)
      if (result.peer) applyPairedPeer(result.peer)
      setBridgeLink(await bridgeLinkStatus())
      setPairingState(result.detail)
      setNotice(result.peer ? `Paired with ${result.peer.name}. Connection settings were filled automatically.` : result.detail)
    } catch (error) {
      setPairingState(error instanceof Error ? error.message : 'Could not approve pairing')
    }
  }

  async function declineAutomaticPair(requestId: string) {
    try {
      setBridgeLink(await bridgeLinkDecline(requestId))
      setPairingState('Pair request declined.')
    } catch (error) {
      setPairingState(error instanceof Error ? error.message : 'Could not decline pairing')
    }
  }

  async function forgetAutomaticPair(instanceId: string) {
    try {
      setBridgeLink(await bridgeLinkForget(instanceId))
      setConfig(c => ({
        ...c,
        machines: c.machines.map(machine => machine.bridgeInstanceId === instanceId ? {
          ...machine,
          agentUrl: machine.id === 'mac' ? 'http://127.0.0.1:4141' : 'http://127.0.0.1:4142',
          agentToken: '',
          rustdeskPeerId: '',
          localsendTarget: '',
          bridgeInstanceId: '',
          syncthingDeviceId: '',
        } : machine),
      }))
      setPairingState('Paired computer forgotten.')
    } catch (error) {
      setPairingState(error instanceof Error ? error.message : 'Could not forget paired computer')
    }
  }

  async function startService(service: ServiceConfig) {
    try {
      setNotice(`Starting ${service.name}…`)
      await managedServiceStart(service.id, service.executable)
      await refresh()
      setNotice(`${service.name} started and is now tracked by BridgeDeck.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not start ${service.name}`)
    }
  }

  async function stopService(service: ServiceConfig) {
    try {
      setNotice(`Stopping ${service.name}…`)
      await managedServiceStop(service.id)
      await refresh()
      setNotice(`${service.name} stopped.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not stop ${service.name}`)
    }
  }

  async function startRustDeskSession(machine: MachineConfig, mode: 'control' | 'file-transfer') {
    if (!machine.rustdeskPeerId) return
    try {
      setNotice(`${mode === 'control' ? 'Connecting to' : 'Opening file transfer with'} ${machine.name}…`)
      let host = ''
      try { host = new URL(machine.agentUrl).hostname } catch { /* manual config */ }
      if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') host = ''
      const route = await connectRustDesk(machine.rustdeskPeerId, rustdeskExe, mode, host)
      setNotice(`RustDesk ${mode === 'control' ? 'control session' : 'file-transfer session'} launched for ${machine.name}${route ? ` via ${route}` : ''}.`)
    } catch (error) {
      // Native command errors arrive as plain strings.
      setNotice(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not start RustDesk session')
    }
  }

  async function addTransferPaths(directory = false) {
    try {
      const picked = await pickTransferPaths(directory)
      if (!picked.length) return
      setTransferPaths(current => Array.from(new Set([...current, ...picked])))
      setTransferState(`${picked.length} ${directory ? 'folder' : 'file'} selection${picked.length === 1 ? '' : 's'} added.`)
    } catch (error) {
      setTransferState(error instanceof Error ? error.message : 'Could not open file picker')
    }
  }

  async function sendWithLocalSend(machine: MachineConfig) {
    if (!machine.localsendTarget || !transferPaths.length || transferBusy) return
    setTransferBusy(true)
    setTransferState(`Sending ${transferPaths.length} selection${transferPaths.length === 1 ? '' : 's'} to ${machine.name}…`)
    try {
      const result = await localSendNativeSend(machine.localsendTarget, transferPaths, machine.localsendPin)
      const detail = result.stdout || result.stderr
      if (!result.ok) throw new Error(detail || 'LocalSend transfer failed')
      setTransferState(`Transfer to ${machine.name} completed.${detail ? ` ${detail}` : ''}`)
    } catch (error) {
      setTransferState(error instanceof Error ? error.message : 'LocalSend transfer failed')
    } finally {
      setTransferBusy(false)
    }
  }

  async function startLocalSendReceiver() {
    try {
      setTransferState('Starting LocalSend receiver…')
      const status = await localSendReceiverStart(config.localsend)
      setLocalsendReceiver(status)
      setTransferState(status.detail || 'LocalSend receiver started.')
    } catch (error) {
      setTransferState(error instanceof Error ? error.message : 'Could not start LocalSend receiver')
    }
  }

  async function stopLocalSendReceiver() {
    try {
      const status = await localSendReceiverStop()
      setLocalsendReceiver(status)
      setTransferState('LocalSend receiver stopped.')
    } catch (error) {
      setTransferState(error instanceof Error ? error.message : 'Could not stop LocalSend receiver')
    }
  }

  async function answerLocalSend(accept: boolean) {
    const sessionId = localsendReceiver.pending?.sessionId
    if (!sessionId) return
    try {
      const status = accept ? await localSendAccept(sessionId) : await localSendDecline(sessionId)
      setLocalsendReceiver(status)
      setTransferState(accept ? 'Incoming transfer accepted.' : 'Incoming transfer declined.')
    } catch (error) {
      setTransferState(error instanceof Error ? error.message : 'Could not answer incoming transfer')
    }
  }

  useEffect(() => {
    if (page !== 'ai') return
    let cancelled = false
    const poll = async () => {
      try {
        const messages = await bridgeLinkAiMessages(0)
        if (!cancelled) setAiFeed(messages.slice(-200))
      } catch (error) {
        if (!cancelled) setAiState(error instanceof Error ? error.message : String(error))
      }
    }
    void poll()
    void bridgeLinkAiTokenPath().then(setAiTokenPath).catch(() => undefined)
    const timer = window.setInterval(() => void poll(), 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [page, bridgeLink.running])

  async function submitAiRelay() {
    const body = aiText.trim()
    if (!body) return
    try {
      setAiState('Sending…')
      const message = await bridgeLinkAiSend('human', body)
      setAiFeed(feed => [...feed, message])
      setAiText('')
      setAiState(`Delivered to ${message.peerName}`)
    } catch (error) {
      setAiState(error instanceof Error ? error.message : String(error))
    }
  }

  const title = ({
    home: 'Home', computers: 'Computers', remote: 'Remote', messages: 'Messages', ai: 'AI Center',
    files: 'Files', sync: 'Sync', services: 'Services', settings: 'Settings',
  } as Record<PageKey, string>)[page]

  return (
    <div className="shell">
      <Sidebar page={page} setPage={setPage} badges={{ messages: messagesUnread }} />
      <main>
        <header className="topbar">
          <h1>{title}</h1>
          <div className="top-actions">{!hydrated && <span className="save-state">Loading…</span>}<button className="icon-button" onClick={() => void refresh()} title="Refresh"><RefreshCw size={16} /></button></div>
        </header>
        {notice && <div className="notice"><Activity size={15}/><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
        {sourceUpdate?.rebuildNeeded && <div className="notice"><RefreshCw size={15}/><span>BridgeDeck source changed since this build (newest: {sourceUpdate.newestSourceFile}, {new Date(sourceUpdate.newestSourceAt).toLocaleString()}). Rebuild to pick up the synced changes; ask Claude or Codex to run the build here.</span></div>}

        {page === 'home' && <>
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
              <div className="stack compact"><div className="service-row"><span className="service-dot" data-on={rustdeskInfo.available}/><div className="grow"><strong>Remote</strong><small>{rustdeskInfo.available ? `RustDesk ${rustdeskInfo.id ? `ID ${rustdeskInfo.id}` : 'runtime ready'}` : 'RustDesk runtime not found'}</small></div><StatusPill online={rustdeskInfo.available} label={rustdeskInfo.available ? 'Ready' : 'Setup'}/></div><div className="service-row"><span className="service-dot" data-on={localsendReceiver.running}/><div className="grow"><strong>Files</strong><small>{localsendReceiver.running ? `Receiving as ${localsendReceiver.alias}:${localsendReceiver.port}` : 'Native LocalSend core ready; receiver stopped'}</small></div><StatusPill online={localsendReceiver.running} label={localsendReceiver.running ? 'Receiving' : 'Stopped'}/></div></div>
            </Card>
          </div>
          <Card><SectionTitle title="Quick actions" /><div className="actions"><button onClick={() => setPage('remote')}><MonitorUp size={18}/>Remote</button><button onClick={() => setPage('files')}><Upload size={18}/>Send files</button><button onClick={() => setPage('messages')}><MessageSquare size={18}/>Messages</button><button className="secondary" onClick={() => setPage('services')}><ServerCog size={18}/>Manage services</button></div></Card>
        </>}

        {page === 'computers' && <>
          <Card className="pairing-card"><SectionTitle title="Automatic Mac ↔ Windows pairing" subtitle={pairingState} action={<StatusPill online={bridgeLink.running} label={bridgeLink.running ? 'Discovering' : 'Stopped'}/>} />
            <div className="pairing-summary"><div><Wifi size={20}/><span><strong>{bridgeLink.displayName || 'BridgeDeck'}</strong><small>{bridgeLink.running ? `LAN discovery · TCP ${bridgeLink.apiPort}` : 'Start pairing to discover the other computer'}</small></span></div><div className="actions"><button className="secondary" onClick={() => void startAutomaticPairing()}><RefreshCw size={16}/>Restart discovery</button></div></div>
            {bridgeLink.outgoing && <div className="pair-request outgoing"><div><strong>Waiting for {bridgeLink.outgoing.peerName}</strong><small>Verify this code on both computers before approving.</small></div><code>{bridgeLink.outgoing.pairingCode}</code></div>}
            {!!bridgeLink.pending.length && <div className="pair-section"><h3>Incoming requests</h3>{bridgeLink.pending.map(request => <div className="pair-request" key={request.requestId}><div><strong>{request.peerName}</strong><small>{request.peerPlatform} · {request.host}</small></div><code>{request.pairingCode}</code><div className="actions"><button onClick={() => void approveAutomaticPair(request.requestId)}><ShieldCheck size={16}/>Approve</button><button className="secondary" onClick={() => void declineAutomaticPair(request.requestId)}>Decline</button></div></div>)}</div>}
            <div className="pair-section"><h3>Discovered computers</h3>{bridgeLink.discovered.filter(peer => !bridgeLink.paired.some(paired => paired.instanceId === peer.instanceId)).length ? <div className="pair-list">{bridgeLink.discovered.filter(peer => !bridgeLink.paired.some(paired => paired.instanceId === peer.instanceId)).map(peer => <div className="pair-peer" key={peer.instanceId}><div><Computer size={18}/><span><strong>{peer.name}</strong><small>{peer.platform} · {peer.host}:{peer.apiPort}</small></span></div><button disabled={!!bridgeLink.outgoing} onClick={() => void requestAutomaticPair(peer)}>Pair</button></div>)}</div> : <div className="bb-placeholder">{bridgeLink.running ? 'Waiting for another BridgeDeck instance on this LAN…' : 'Automatic discovery is stopped.'}</div>}</div>
            {!!bridgeLink.paired.length && <div className="pair-section"><h3>Paired</h3><div className="pair-list">{bridgeLink.paired.map(peer => { const syncState = syncthingSetup[peer.instanceId]; return <div className="pair-peer" key={peer.instanceId}><div><ShieldCheck size={18}/><span><strong>{peer.name}</strong><small>{peer.platform} · RustDesk {peer.rustdeskPeerId || 'not reported'} · LocalSend {peer.localsendTarget} · Syncthing {peer.syncthingDeviceId ? 'ID received' : 'waiting for ID'}</small>{syncState && <small>{'error' in syncState ? syncState.error : syncState.detail}</small>}</span></div><div className="actions"><button className="secondary" disabled={!config.syncthing.apiKey} onClick={() => void configureSyncthingPeer(peer)}><ArrowLeftRight size={16}/>Setup sync</button><button className="ghost" title="Forget pairing" onClick={() => void forgetAutomaticPair(peer.instanceId)}><Trash2 size={16}/></button></div></div> })}</div></div>}
            <p className="vendor-note">Pair only on a trusted LAN and confirm the six-digit code on both screens. v0.7 authenticates paired status requests with persisted bearer tokens and exchanges Syncthing device IDs; the initial LAN token exchange is not yet TLS-encrypted.</p>
          </Card>
          <div className="machine-cards">
            {config.machines.map(m => { const status = machineStatus[m.id]; return <Card key={m.id}><SectionTitle title={m.name} subtitle={status?.hostname || m.agentUrl} action={<StatusPill online={!!status?.ok}/>} /><div className="spec-grid"><div><Gauge/><span>Uptime<strong>{fmtUptime(status?.uptimeSeconds)}</strong></span></div><div><HardDrive/><span>Memory free<strong>{fmtBytes(status?.freeMemory)}</strong></span></div><div><TerminalSquare/><span>Platform<strong>{status?.platform || '—'} {status?.arch || ''}</strong></span></div><div><ShieldCheck/><span>Connection<strong>{m.bridgeInstanceId ? `BridgeLink paired${m.syncthingDeviceId ? ' + sync ID' : ''}` : m.agentToken ? 'Bearer token' : 'Local/manual'}</strong></span></div></div><div className="actions"><button disabled={!m.rustdeskPeerId} onClick={() => void startRustDeskSession(m, 'control')}><Computer size={17}/>Control</button><button className="secondary" disabled={!m.sharedPath} onClick={() => void openPath(m.sharedPath)}><FolderOpen size={17}/>Shared folder</button></div>{status?.error && <p className="error-text">{status.error}</p>}</Card> })}
          </div>
        </>}

        {page === 'remote' && <>
          <div className="remote-hero">
            <Card><SectionTitle title="This computer" subtitle="RustDesk identity detected by BridgeDeck" action={<StatusPill online={rustdeskInfo.available} label={rustdeskInfo.available ? 'Ready' : 'Missing'}/>} /><div className="remote-id"><MonitorUp size={28}/><div><span>RustDesk ID</span><strong>{rustdeskInfo.id || 'Not available yet'}</strong><small>{rustdeskInfo.executable || rustdeskInfo.detail || 'Build/import the RustDesk runtime or install RustDesk.'}</small></div></div><div className="actions"><button className="secondary" onClick={() => void launchApp('rustdesk', rustdeskExe)}>Open original RustDesk UI</button><button className="secondary" onClick={() => void refresh()}><RefreshCw size={16}/>Refresh ID</button></div></Card>
            <Card><SectionTitle title="BridgeDeck Remote" subtitle="BridgeDeck owns peer selection and session mode" /><div className="remote-note"><ShieldCheck size={22}/><p>Control and file-transfer sessions are launched directly from this page. RustDesk still renders the remote desktop window and handles its authentication/transport.</p></div></Card>
          </div>
          <div className="machine-cards">{config.machines.map(machine => <Card key={machine.id}><SectionTitle title={machine.name} subtitle={machine.rustdeskPeerId ? `Peer ${machine.rustdeskPeerId}` : 'Add RustDesk peer ID in Settings'} action={<StatusPill online={Boolean(machine.rustdeskPeerId && rustdeskInfo.available)} label={machine.rustdeskPeerId ? 'Paired' : 'Unpaired'}/>} /><div className="remote-actions"><button disabled={!machine.rustdeskPeerId || !rustdeskInfo.available} onClick={() => void startRustDeskSession(machine, 'control')}><MonitorUp size={18}/><span><strong>Control computer</strong><small>Interactive RustDesk desktop session</small></span></button><button disabled={!machine.rustdeskPeerId || !rustdeskInfo.available} onClick={() => void startRustDeskSession(machine, 'file-transfer')}><FolderOpen size={18}/><span><strong>RustDesk file transfer</strong><small>Use RustDesk's direct peer transfer mode</small></span></button></div></Card>)}</div>
        </>}

        {/* Always mounted: keeps polling for desktop notifications and the unread badge on every page. */}
        <div hidden={page !== 'messages'}><Messages baseUrl={config.bluebubbles.baseUrl} password={config.bluebubbles.password} visible={page === 'messages'} onUnreadChange={setMessagesUnread} /></div>

        {page === 'ai' && <div className="two-col ai-layout">
          <Card><SectionTitle title="AI Message Center" subtitle="BridgeLink relay (paired computers, LAN)" />
            <p className="vendor-note">AI assistants on each computer (for example Claude on Windows and Codex on the Mac) use <code>agent/ai-relay.mjs</code> to send and read here. Messages are data only; BridgeDeck never runs commands from them. Local AI token: <code>{aiTokenPath || 'available after BridgeLink starts'}</code></p></Card>
          <Card className="chat-card"><SectionTitle title="# bridgelink-agents" subtitle={aiState || (bridgeLink.paired.length ? `Paired with ${bridgeLink.paired.map(p => p.name).join(', ')}` : 'Pair the computers first (Computers page)')} action={<button className="icon-button" onClick={() => void bridgeLinkAiMessages(0).then(m => setAiFeed(m.slice(-200)))}><RefreshCw size={16}/></button>} />
            <div className="matrix-feed">{aiFeed.length ? aiFeed.map(m => <div className="matrix-message" key={m.id}><small>{m.author} · {m.direction === 'out' ? `this computer → ${m.peerName}` : `from ${m.peerName}`} · {new Date(m.createdAt).toLocaleTimeString()}</small><span style={{ whiteSpace: 'pre-wrap' }}>{m.body}</span></div>) : <div className="chat-empty"><Bot/><h3>AI relay</h3><p>Messages between the AI assistants on your paired computers appear here. You can post too.</p></div>}</div>
            <div className="composer"><input value={aiText} onChange={e => setAiText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submitAiRelay() }} placeholder="Message the other computer's AI…"/><button onClick={() => void submitAiRelay()} disabled={!aiText.trim() || !bridgeLink.paired.length}><Send size={16}/></button></div>
          </Card>
        </div>}

        {page === 'files' && <>
          <div className="two-col files-top">
            <Card><SectionTitle title="Transfer queue" subtitle={`${transferPaths.length} selection${transferPaths.length === 1 ? '' : 's'} queued`} action={<StatusPill online label="Native core"/>} /><div className="actions"><button onClick={() => void addTransferPaths(false)}><FilePlus2 size={17}/>Choose files</button><button className="secondary" onClick={() => void addTransferPaths(true)}><FolderPlus size={17}/>Choose folder</button><button className="secondary" disabled={!transferPaths.length} onClick={() => setTransferPaths([])}><Trash2 size={17}/>Clear</button></div><div className="transfer-list">{transferPaths.length ? transferPaths.map(path => <div key={path}><Upload size={15}/><span title={path}>{shortPath(path)}</span><small>{path}</small></div>) : <div className="bb-placeholder">Nothing queued yet.</div>}</div><p className="transfer-state">{transferState}</p></Card>
            <Card><SectionTitle title="Receive on this computer" subtitle={localsendReceiver.detail || 'BridgeDeck runs the LocalSend protocol server itself'} action={<StatusPill online={localsendReceiver.running} label={localsendReceiver.running ? 'Listening' : 'Stopped'}/>} /><div className="remote-id"><Wifi size={26}/><div><span>LocalSend identity</span><strong>{localsendReceiver.alias}:{localsendReceiver.port}</strong><small>{localsendReceiver.fingerprint ? `Fingerprint ${localsendReceiver.fingerprint.slice(0, 18)}…` : 'Identity is created when the receiver starts'}</small></div></div><div className="actions">{localsendReceiver.running ? <button onClick={() => void stopLocalSendReceiver()}><Square size={16}/>Stop receiver</button> : <button onClick={() => void startLocalSendReceiver()}><Play size={16}/>Start receiver</button>}<button className="secondary" disabled={!localsendReceiver.destination} onClick={() => void openPath(localsendReceiver.destination)}><FolderOpen size={16}/>Receive folder</button></div></Card>
          </div>

          {localsendReceiver.pending && <Card className="incoming-card"><SectionTitle title={`Incoming from ${localsendReceiver.pending.senderAlias}`} subtitle={`${localsendReceiver.pending.files.length} file${localsendReceiver.pending.files.length === 1 ? '' : 's'} · ${fmtSize(localsendReceiver.pending.totalBytes)} · ${localsendReceiver.pending.host}`} action={<StatusPill online label="Approval needed"/>} /><div className="incoming-files">{localsendReceiver.pending.files.slice(0, 8).map(file => <div key={file.id}><span>{file.name}</span><small>{fmtSize(file.size)}</small></div>)}{localsendReceiver.pending.files.length > 8 && <small>+ {localsendReceiver.pending.files.length - 8} more</small>}</div><div className="actions"><button onClick={() => void answerLocalSend(true)}><CheckCircle2 size={17}/>Accept</button><button className="secondary danger" onClick={() => void answerLocalSend(false)}><Trash2 size={17}/>Decline</button></div></Card>}

          {localsendReceiver.active && <Card><SectionTitle title={`Receiving from ${localsendReceiver.active.senderAlias}`} subtitle={`${localsendReceiver.active.filesDone}/${localsendReceiver.active.filesTotal} files`} action={<StatusPill online label="Receiving"/>} /><div className="receive-progress"><div><span style={{ width: `${Math.min(100, localsendReceiver.active.totalBytes ? (localsendReceiver.active.receivedBytes / localsendReceiver.active.totalBytes) * 100 : 0)}%` }}/></div><p>{fmtSize(localsendReceiver.active.receivedBytes)} / {fmtSize(localsendReceiver.active.totalBytes)}</p></div></Card>}

          <div className="machine-cards transfer-destinations">{config.machines.filter(machine => machine.id !== machineIdForPlatform(bridgeLink.platform)).map(machine => <Card key={machine.id}><SectionTitle title={`Send to ${machine.name}`} subtitle={machine.localsendTarget || 'Add a discovered alias or LAN IP in Settings'} action={<StatusPill online={Boolean(machine.localsendTarget)} label={machine.localsendTarget ? 'Target set' : 'Unconfigured'}/>} /><div className="transfer-target"><Computer size={24}/><div><span>Destination</span><strong>{machine.localsendTarget || '—'}</strong><small>Discovered LocalSend alias, IP, or IP:port</small></div></div><button className="send-primary" disabled={!machine.localsendTarget || !transferPaths.length || transferBusy} onClick={() => void sendWithLocalSend(machine)}><Send size={18}/>{transferBusy ? 'Transfer running…' : `Send ${transferPaths.length || ''} ${transferPaths.length === 1 ? 'selection' : 'selections'}`}</button></Card>)}</div>

          <div className="two-col">
            <Card><SectionTitle title="Discovered LocalSend devices" subtitle={`${localsendReceiver.devices.length} device${localsendReceiver.devices.length === 1 ? '' : 's'} seen`} />{localsendReceiver.devices.length ? <div className="device-discovery-list">{localsendReceiver.devices.map(device => <div key={`${device.fingerprint}-${device.host}`}><div><strong>{device.alias}</strong><small>{device.host}:{device.port} · {device.deviceModel || device.protocol}</small></div><button className="ghost" onClick={() => { const target = device.alias; const empty = config.machines.find(m => !m.localsendTarget); if (empty) updateMachine(empty.id, { localsendTarget: target }); setTransferState(`Discovered target: ${target}`) }}>Use target</button></div>)}</div> : <div className="bb-placeholder">Start the receiver to advertise BridgeDeck and discover nearby LocalSend devices.</div>}</Card>
            <Card><SectionTitle title="Recent incoming" subtitle="Stored locally for this BridgeDeck session" />{localsendReceiver.recent.length ? <div className="recent-transfer-list">{localsendReceiver.recent.slice(0, 8).map(item => <div key={`${item.sessionId}-${item.finishedAt}`}><div><strong>{item.senderAlias}</strong><small>{item.message || `${item.files} file${item.files === 1 ? '' : 's'} · ${fmtSize(item.bytes)}`}</small></div><StatusPill online={item.status === 'received' || item.status === 'message'} label={item.status}/></div>)}</div> : <div className="bb-placeholder">No incoming transfers yet.</div>}</Card>
          </div>
          <div className="two-col shared-files">{config.machines.map(m => <Card key={m.id}><SectionTitle title={`${m.name} shared folder`} subtitle={m.sharedPath || 'Shared path not configured'} /><div className="actions"><button disabled={!m.sharedPath} onClick={() => void openPath(m.sharedPath)}><FolderOpen size={17}/>Open shared folder</button></div></Card>)}</div>
        </>}

        {page === 'sync' && <>
          <Card><SectionTitle title="Syncthing" subtitle={syncthing.ok ? `Device ${syncthing.myID || ''}` : syncthing.error || 'Not connected'} action={<StatusPill online={syncthing.ok}/>} /><div className="sync-panel"><Wifi size={28}/><div><h3>{syncthing.ok ? 'Syncthing API connected' : 'Waiting for Syncthing'}</h3><p>Uptime {fmtUptime(syncthing.uptime)} · {syncthingFolderList.length} configured folders</p></div></div><div className="actions"><button onClick={() => void openExternal(config.syncthing.baseUrl)}><Wifi size={17}/>Open Syncthing UI</button><button className="secondary" onClick={() => void refresh()}><RefreshCw size={17}/>Refresh</button></div></Card>
          <Card><SectionTitle title="BridgeDeck Shared" subtitle="Automatic Syncthing workspace for paired computers" action={<StatusPill online={syncthingFolderList.some(folder => folder.id === config.syncthing.sharedFolderId)} label={syncthingFolderList.some(folder => folder.id === config.syncthing.sharedFolderId) ? 'Configured' : 'Waiting'}/>} /><p className="vendor-note">Folder ID: {config.syncthing.sharedFolderId} · Local path: {syncthingFolderList.find(folder => folder.id === config.syncthing.sharedFolderId)?.path || config.syncthing.sharedFolderPath || '~/BridgeDeck Shared'}</p><div className="actions">{bridgeLink.paired.map(peer => <button key={peer.instanceId} className="secondary" disabled={!config.syncthing.apiKey} onClick={() => void configureSyncthingPeer(peer)}><ArrowLeftRight size={16}/>Link {peer.name}</button>)}{syncthingFolderList.find(folder => folder.id === config.syncthing.sharedFolderId)?.path && <button className="secondary" onClick={() => void openPath(syncthingFolderList.find(folder => folder.id === config.syncthing.sharedFolderId)!.path!)}><FolderOpen size={16}/>Open workspace</button>}</div></Card>
          <div className="folder-grid">{syncthingFolderList.map(folder => <Card key={folder.id}><SectionTitle title={folder.label || folder.id} subtitle={folder.path || folder.id} action={<StatusPill online={!folder.paused} label={folder.paused ? 'Paused' : 'Active'}/>} /><p className="vendor-note">Type: {folder.type || 'sendreceive'}</p>{folder.path && <button className="ghost" onClick={() => void openPath(folder.path!)}><FolderOpen size={16}/>Open folder</button>}</Card>)}</div>
        </>}

        {page === 'services' && <>
          <Card className="service-summary"><SectionTitle title="Managed runtime" subtitle="BridgeDeck only stops processes that it started itself." /><p className="vendor-note">RustDesk, Syncthing and BlueBubbles can use bundled runtimes. LocalSend send/receive now runs directly through the vendored Rust core inside BridgeDeck.</p></Card>
          <div className="services-grid">{config.services.map(service => { const pin = vendorPins.find(v => v.id === service.id || (service.id === 'bluebubbles' && v.id === 'bluebubbles')); const managed = managedState[service.id]; const ready = !!serviceStatus[service.id] || !!managed?.running; return <Card key={service.id}><div className="service-head"><div className="service-icon"><ServerCog size={20}/></div><div className="grow"><h3>{service.name}</h3><p>{service.notes}</p></div><StatusPill online={ready} label={managed?.running ? 'Managed' : ready ? 'Ready' : 'Offline'}/></div><div className="service-meta"><span>{pin?.version || 'BridgeDeck native'}</span><span>{pin?.license || '—'}</span></div><p className="runtime-line">Runtime: {managed?.executableReady ? 'executable ready' : service.id === 'localsend' ? 'integrated Rust core' : 'set executable path or import runtime'}</p><div className="actions">{service.id !== 'localsend' && <>{managed?.running ? <button onClick={() => void stopService(service)}><Square size={16}/>Stop</button> : <button disabled={!managed?.executableReady} onClick={() => void startService(service)}><Play size={16}/>Start</button>}<button className="secondary" onClick={() => void launchApp(service.id, service.executable)}>Open</button></>}{service.id === 'localsend' && <button onClick={() => setPage('files')}><Upload size={16}/>Open Files</button>} {service.webUrl && <button className="secondary" onClick={() => void openExternal(service.webUrl!)}>Web UI</button>}</div>{managed?.detail && <p className="vendor-note">{managed.detail}</p>}</Card> })}</div>
        </>}

        {page === 'settings' && <div className="settings-stack">
          <Card><SectionTitle title="Automatic pairing" subtitle="BridgeLink discovers and pairs BridgeDeck instances on the same LAN" action={<StatusPill online={bridgeLink.running} label={bridgeLink.running ? 'Running' : 'Stopped'}/>} /><label>Computer display name<input value={config.pairing.displayName} onChange={e => setConfig(c => ({ ...c, pairing: { ...c.pairing, displayName: e.target.value } }))} placeholder="Blank = system computer name"/></label><label>BridgeLink API port<input type="number" value={config.pairing.apiPort} onChange={e => setConfig(c => ({ ...c, pairing: { ...c.pairing, apiPort: Number(e.target.value) || 41416 } }))}/></label><Toggle checked={config.pairing.autoStart} onChange={autoStart => setConfig(c => ({ ...c, pairing: { ...c.pairing, autoStart } }))} label="Start LAN discovery automatically"/><div className="actions"><button onClick={() => void startAutomaticPairing()}><Wifi size={17}/>Start / restart pairing</button><button className="secondary" onClick={() => void bridgeLinkStop().then(status => { setBridgeLink(status); setPairingState('Automatic pairing stopped.') })}><Square size={16}/>Stop</button></div><p className="vendor-note">Discovery uses UDP multicast port 41415. The status/pairing API defaults to TCP 41416. Approve only when the six-digit code matches on both computers.</p></Card>

          <Card><SectionTitle title="Computers" subtitle="BridgeLink pairing fills these fields automatically; manual overrides remain available" />{config.machines.map(m => <div className="settings-block" key={m.id}><h3>{m.name}</h3><label>Agent URL<input value={m.agentUrl} onChange={e => updateMachine(m.id, { agentUrl: e.target.value })}/></label><label>Agent bearer token<input type="password" value={m.agentToken} onChange={e => updateMachine(m.id, { agentToken: e.target.value })} placeholder="Blank for localhost-only agent"/></label><label>RustDesk peer ID<input value={m.rustdeskPeerId} onChange={e => updateMachine(m.id, { rustdeskPeerId: e.target.value })} placeholder="Numeric RustDesk ID"/></label><label>LocalSend target<input value={m.localsendTarget} onChange={e => updateMachine(m.id, { localsendTarget: e.target.value })} placeholder="Exact LocalSend alias or LAN IP"/></label><label>Remote LocalSend PIN<input type="password" value={m.localsendPin} onChange={e => updateMachine(m.id, { localsendPin: e.target.value })} placeholder="Only if that receiver requires one"/></label><label>BridgeLink instance ID<input value={m.bridgeInstanceId} onChange={e => updateMachine(m.id, { bridgeInstanceId: e.target.value })} placeholder="Filled automatically after pairing"/></label><label>Syncthing device ID<input value={m.syncthingDeviceId} onChange={e => updateMachine(m.id, { syncthingDeviceId: e.target.value })} placeholder="Filled automatically after pairing"/></label><label>Shared folder path<input value={m.sharedPath} onChange={e => updateMachine(m.id, { sharedPath: e.target.value })}/></label></div>)}</Card>

          <Card><SectionTitle title="Native LocalSend" subtitle="BridgeDeck uses vendor/localsend/packages/core directly" /><label>Device alias<input value={config.localsend.alias} onChange={e => setConfig(c => ({ ...c, localsend: { ...c.localsend, alias: e.target.value } }))} placeholder="BridgeDeck"/></label><label>Receive folder<input value={config.localsend.destination} onChange={e => setConfig(c => ({ ...c, localsend: { ...c.localsend, destination: e.target.value } }))} placeholder="Blank = system Downloads folder"/></label><div className="field-row"><label>Port<input type="number" value={config.localsend.port} onChange={e => setConfig(c => ({ ...c, localsend: { ...c.localsend, port: Number(e.target.value) || 53317 } }))}/></label><label>Optional PIN<input type="password" value={config.localsend.pin} onChange={e => setConfig(c => ({ ...c, localsend: { ...c.localsend, pin: e.target.value } }))}/></label></div><Toggle checked={config.localsend.autoAccept} onChange={autoAccept => setConfig(c => ({ ...c, localsend: { ...c.localsend, autoAccept } }))} label="Auto-accept incoming transfers"/><p className="vendor-note">Manual approval is the default. If auto-accept is enabled, any sender that can reach this LocalSend endpoint can transfer files unless a PIN is set.</p></Card>

          <Card><SectionTitle title="Service manager" subtitle="One set of controls for BridgeDeck runtimes" />{config.services.map(service => <div className="settings-block" key={service.id}><div className="settings-heading"><h3>{service.name}</h3><div className="toggle-cluster"><Toggle checked={service.enabled} onChange={enabled => updateService(service.id, { enabled })} label="Enabled"/><Toggle checked={service.autoStart} onChange={autoStart => updateService(service.id, { autoStart })} label="Auto-start"/></div></div>{service.id !== 'localsend' && <label>Direct runtime executable<input value={service.executable || ''} onChange={e => updateService(service.id, { executable: e.target.value })} placeholder="/path/to/built/runtime"/></label>}{service.host !== undefined && <div className="field-row"><label>Health host<input value={service.host || ''} onChange={e => updateService(service.id, { host: e.target.value })}/></label><label>Port<input type="number" value={service.port || ''} onChange={e => updateService(service.id, { port: Number(e.target.value) || undefined })}/></label></div>}</div>)}</Card>

          <Card><SectionTitle title="BlueBubbles" subtitle="Mac-side iMessage service" /><label>Server URL<input value={config.bluebubbles.baseUrl} onChange={e => setConfig(c => ({ ...c, bluebubbles: { ...c.bluebubbles, baseUrl: e.target.value } }))} placeholder="http://127.0.0.1:1234"/></label><label>Server password<input type="password" value={config.bluebubbles.password} onChange={e => setConfig(c => ({ ...c, bluebubbles: { ...c.bluebubbles, password: e.target.value } }))}/></label></Card>

          <Card><SectionTitle title="Syncthing" subtitle="BridgeDeck can automatically add the paired device and create the shared workspace" /><label>REST base URL<input value={config.syncthing.baseUrl} onChange={e => setConfig(c => ({ ...c, syncthing: { ...c.syncthing, baseUrl: e.target.value } }))}/></label><label>API key<input type="password" value={config.syncthing.apiKey} onChange={e => setConfig(c => ({ ...c, syncthing: { ...c.syncthing, apiKey: e.target.value } }))}/></label><Toggle checked={config.syncthing.autoSetup} onChange={autoSetup => setConfig(c => ({ ...c, syncthing: { ...c.syncthing, autoSetup } }))} label="Automatically configure Syncthing after BridgeLink pairing"/><div className="field-row"><label>Shared folder ID<input value={config.syncthing.sharedFolderId} onChange={e => setConfig(c => ({ ...c, syncthing: { ...c.syncthing, sharedFolderId: e.target.value } }))} placeholder="bridgedeck-shared"/></label><label>Shared folder label<input value={config.syncthing.sharedFolderLabel} onChange={e => setConfig(c => ({ ...c, syncthing: { ...c.syncthing, sharedFolderLabel: e.target.value } }))} placeholder="BridgeDeck Shared"/></label></div><label>Local shared folder path<input value={config.syncthing.sharedFolderPath} onChange={e => setConfig(c => ({ ...c, syncthing: { ...c.syncthing, sharedFolderPath: e.target.value } }))} placeholder="Blank = ~/BridgeDeck Shared"/></label><p className="vendor-note">The Syncthing API key stays on this computer. BridgeLink exchanges only Syncthing device IDs, which Syncthing treats as public identifiers.</p></Card>

          <Card><SectionTitle title="Configuration" subtitle="Native builds persist config in the BridgeDeck app-config directory; browser dev mode also keeps a localStorage copy." /><div className="actions"><button className="secondary" onClick={() => setConfig(structuredClone(defaultConfig))}><Settings2 size={17}/>Reset defaults</button><button className="secondary" onClick={() => void refresh()}><CheckCircle2 size={17}/>Recheck integrations</button></div></Card>
        </div>}
      </main>
    </div>
  )
}
