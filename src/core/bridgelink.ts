import { useEffect, useRef } from 'react'
import {
  bridgeLinkApprove, bridgeLinkConfirmPair, bridgeLinkDecline, bridgeLinkForget, bridgeLinkLegacyUpgrade, bridgeLinkPeerStatus,
  bridgeLinkPollPair, bridgeLinkRefreshPeer, bridgeLinkRequestPair, bridgeLinkStart, bridgeLinkStatus, bridgeLinkStop, fetchAgent,
  bridgeLinkWake, sourceUpdateStatus,
} from '../lib/bridge'
import type { AgentStatus, BridgeLinkPairedPeer, BridgeLinkPeer, BridgeLinkStatus, DeviceConfig, SourceUpdateStatus } from '../types'
import { configStore, hydratedStore, removeDevice, setConfig, upsertDevice } from './config'
import { setNotice } from './notice'
import { usePeriodicRefresh } from './refresh'
import { createStore, useStore } from './store'
import { agentUrlFor, errorText } from './util'

// BridgeLink is shared infrastructure: every feature reaches the paired computers through it.

/** Sends the Wake-on-LAN packet to a sleeping paired computer and says so. */
export async function wakeDevice(instanceId: string) {
  try { setNotice(await bridgeLinkWake(instanceId)) } catch (error) { setNotice(errorText(error, 'Could not send the wake-up')) }
}

export const bridgeLinkStore = createStore<BridgeLinkStatus>({ running: false, instanceId: '', displayName: 'BridgeDeck', platform: '', apiPort: 41416, discovered: [], pending: [], paired: [] })
export const pairingStateStore = createStore('Automatic pairing has not started yet.')
/** Live status of each device, keyed by device id. */
export const deviceStatusStore = createStore<Record<string, AgentStatus>>({})
export const sourceUpdateStore = createStore<SourceUpdateStatus | null>(null)

/** Identifiers this computer advertises to paired peers. Features publish theirs with `advertise` as
 *  soon as they know them; BridgeLink then re-advertises. Empty values are ignored natively. */
export const advertisedStore = createStore({ syncthingId: '' })

export function advertise(patch: Partial<{ syncthingId: string }>) {
  advertisedStore.set(current => Object.entries(patch).every(([key, value]) => current[key as keyof typeof current] === value) ? current : { ...current, ...patch })
}

/** Only non-empty values: an ID a peer hasn't reported yet never clears one already known. */
const known = (patch: Partial<DeviceConfig>) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== '')) as Partial<DeviceConfig>

function applyLocalBridge(status: BridgeLinkStatus, syncthingDeviceId?: string) {
  if (!status.instanceId) return
  // A previous identity of this computer (reinstall, reset) is replaced rather than kept as a second "this computer".
  setConfig(c => c.devices.some(d => d.local && d.id !== status.instanceId) ? { ...c, devices: c.devices.filter(d => !d.local || d.id === status.instanceId) } : c)
  upsertDevice(status.instanceId, {
    local: true,
    agentUrl: `http://127.0.0.1:${status.apiPort}`,
    agentToken: '',
    localsendTarget: `127.0.0.1:${configStore.get().localsend.port}`,
    ...known({ syncthingDeviceId }),
  }, { name: status.displayName || 'This computer', platform: status.platform, local: true })
}

/** Adds or updates the paired computer's device entry. Runs at pairing, at start-up and on every refresh. */
export function applyPairedPeer(peer: BridgeLinkPairedPeer) {
  upsertDevice(peer.instanceId, {
    platform: peer.platform,
    // Status travels over the encrypted link (bridgeLinkPeerStatus); the URL is kept for the address.
    agentUrl: agentUrlFor(peer.host, peer.apiPort),
    agentToken: '',
    ...known({ localsendTarget: peer.localsendTarget, syncthingDeviceId: peer.syncthingDeviceId }),
  }, { name: peer.name, platform: peer.platform, local: false })
}

/** Asks the paired computer for its latest details (new IP, Syncthing ID) and applies them. */
export async function refreshPeer(instanceId: string): Promise<BridgeLinkPairedPeer | undefined> {
  const refreshed = await bridgeLinkRefreshPeer(instanceId)
  if (refreshed.peer) applyPairedPeer(refreshed.peer)
  return refreshed.peer
}

export async function startAutomaticPairing() {
  const config = configStore.get()
  try {
    pairingStateStore.set('Starting LAN discovery…')
    // No stop/start here: BridgeLink is already running from process start, and bridgeLinkStart only
    // refreshes what it advertises (it rebinds natively if the API port changed).
    const { syncthingId } = advertisedStore.get()
    const status = await bridgeLinkStart(config.pairing.displayName, config.pairing.apiPort, config.localsend.port, syncthingId)
    bridgeLinkStore.set(status)
    status.paired.forEach(applyPairedPeer)
    applyLocalBridge(status, syncthingId)
    pairingStateStore.set(status.detail || 'Automatic pairing is active.')
  } catch (error) {
    pairingStateStore.set(errorText(error, 'Could not start automatic pairing'))
  }
}

export async function stopAutomaticPairing() {
  try {
    bridgeLinkStore.set(await bridgeLinkStop())
    pairingStateStore.set('Automatic pairing stopped.')
  } catch { /* browser mode */ }
}

export async function requestAutomaticPair(peer: BridgeLinkPeer) {
  try {
    const status = await bridgeLinkRequestPair(peer.instanceId)
    bridgeLinkStore.set(status)
    pairingStateStore.set(`Connecting securely to ${peer.name}…`)
  } catch (error) {
    pairingStateStore.set(errorText(error, 'Could not request pairing'))
  }
}

/** This computer's person saw the same code on both screens and approves an incoming pairing. */
export async function approveAutomaticPair(requestId: string) {
  try {
    const result = await bridgeLinkApprove(requestId)
    bridgeLinkStore.set(await bridgeLinkStatus())
    pairingStateStore.set(result.detail)
  } catch (error) {
    pairingStateStore.set(errorText(error, 'Could not approve pairing'))
  }
}

/** Answer on a pairing this computer started, after comparing the codes: `true` = they match. */
export async function confirmOutgoingPair(match: boolean) {
  try {
    bridgeLinkStore.set(await bridgeLinkConfirmPair(match))
    pairingStateStore.set(match ? 'Waiting for the other computer to confirm…' : 'Pairing cancelled.')
  } catch (error) {
    pairingStateStore.set(errorText(error, 'Could not confirm pairing'))
  }
}

/** Asks a computer still on BridgeDeck 0.8 to update itself so it can be paired securely. */
export async function upgradeLegacyPeer(instanceId: string, name: string, version: string) {
  try {
    setNotice(`Asking ${name} to update; allow it there…`)
    await bridgeLinkLegacyUpgrade(instanceId, version)
    setNotice(`${name} is updating. Pair it again when it restarts.`)
  } catch (error) {
    setNotice(errorText(error, `Could not ask ${name} to update`))
  }
}

export async function declineAutomaticPair(requestId: string) {
  try {
    bridgeLinkStore.set(await bridgeLinkDecline(requestId))
    pairingStateStore.set('Pair request declined.')
  } catch (error) {
    pairingStateStore.set(errorText(error, 'Could not decline pairing'))
  }
}

export async function forgetAutomaticPair(instanceId: string) {
  try {
    bridgeLinkStore.set(await bridgeLinkForget(instanceId))
    removeDevice(instanceId)
    pairingStateStore.set('Paired computer forgotten.')
  } catch (error) {
    pairingStateStore.set(errorText(error, 'Could not forget paired computer'))
  }
}

/** Mounted once by the shell: keeps BridgeLink status, pairing and device status current. */
export function BridgeLinkBackground() {
  const hydrated = useStore(hydratedStore)
  const config = useStore(configStore)
  const { syncthingId } = useStore(advertisedStore)
  const running = useStore(bridgeLinkStore).running
  const pairPollBusy = useRef(false)

  useEffect(() => {
    if (!hydrated) return
    if (config.pairing.autoStart) void startAutomaticPairing()
    else void bridgeLinkStop().then(bridgeLinkStore.set).catch(() => undefined)
  }, [hydrated, config.pairing.autoStart])

  useEffect(() => {
    if (!hydrated) return
    const poll = async () => {
      try {
        const status = await bridgeLinkStatus()
        bridgeLinkStore.set(status)
        // Finished pairings, started on either computer.
        if (!pairPollBusy.current) {
          pairPollBusy.current = true
          try {
            const result = await bridgeLinkPollPair()
            if (result.paired && result.peer) {
              applyPairedPeer(result.peer)
              setNotice(`Paired with ${result.peer.name}. The connection is encrypted and settings were filled automatically.`)
              pairingStateStore.set(result.detail)
              bridgeLinkStore.set(await bridgeLinkStatus())
            } else if (result.detail) {
              pairingStateStore.set(result.detail)
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

  // Re-advertise when the Sync feature learns this computer's Syncthing ID.
  useEffect(() => {
    if (!hydrated || !running || !syncthingId) return
    const current = configStore.get()
    void bridgeLinkStart(current.pairing.displayName, current.pairing.apiPort, current.localsend.port, syncthingId)
      .then(status => { bridgeLinkStore.set(status); applyLocalBridge(status, syncthingId) })
      .catch(() => undefined)
  }, [hydrated, syncthingId])

  usePeriodicRefresh(async () => {
    // Paired devices over the encrypted link; this computer and hand-added ones over HTTP.
    const paired = new Set(bridgeLinkStore.get().paired.map(p => p.instanceId))
    const devices = configStore.get().devices.filter(d => paired.has(d.id) || d.agentUrl)
    const statuses = await Promise.all(devices.map(async d => [d.id, paired.has(d.id) && !d.local ? await bridgeLinkPeerStatus(d.id) : await fetchAgent(d.agentUrl, d.agentToken)] as const))
    deviceStatusStore.set(Object.fromEntries(statuses))
    try { sourceUpdateStore.set(await sourceUpdateStatus()) } catch { /* browser mode */ }
    // Pick up peer changes made after pairing (new IP, Syncthing ID).
    try {
      const link = await bridgeLinkStatus()
      for (const peer of link.paired) {
        try { await refreshPeer(peer.instanceId) } catch { /* peer offline */ }
      }
    } catch { /* browser mode */ }
  }, 15000, [config.devices])

  return null
}
