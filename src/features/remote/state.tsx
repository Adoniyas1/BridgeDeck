import { useEffect } from 'react'
import { connectRustDesk, isTauri, remoteHostSettings, remoteHostStatus, remoteHostStop, rustDeskEnsureRunning, rustDeskIdentity, type RemoteHostStatus } from '../../lib/bridge'
import { advertise } from '../../core/bridgelink'
import { configStore, serviceConfig } from '../../core/config'
import { setNotice } from '../../core/notice'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { openTab } from '../../core/tabs'
import type { DeviceConfig, RustDeskIdentity } from '../../types'

export const rustdeskInfoStore = createStore<RustDeskIdentity>({ available: false })
/** This computer as a remote-control host: supported, settings, who's controlling it now. */
export const hostStore = createStore<RemoteHostStatus>({ supported: false, settings: { allow: true, askFirst: false }, sessions: [] })

/** Opens (or shows) the tab controlling a paired device. */
export function controlDevice(device: { id: string; name: string }) {
  openTab({ id: `remote:${device.id}`, kind: 'remote-session', title: device.name, params: { peer: device.id, name: device.name } })
}

export async function stopHosting() {
  try { hostStore.set(await remoteHostStop()) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
}

export const rustdeskExecutable = () => serviceConfig(configStore.get(), 'rustdesk')?.executable

export async function refreshRustDeskIdentity() {
  try {
    const identity = await rustDeskIdentity(rustdeskExecutable())
    rustdeskInfoStore.set(identity)
    if (identity.id) advertise({ rustdeskId: identity.id })
  } catch {
    rustdeskInfoStore.set({ available: false })
  }
}

export async function startRustDeskSession(machine: DeviceConfig, mode: 'control' | 'file-transfer') {
  if (!machine.rustdeskPeerId) return
  try {
    setNotice(`${mode === 'control' ? 'Connecting to' : 'Opening file transfer with'} ${machine.name}…`)
    let host = ''
    try { host = new URL(machine.agentUrl).hostname } catch { /* manual config */ }
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') host = ''
    const route = await connectRustDesk(machine.rustdeskPeerId, rustdeskExecutable(), mode, host)
    setNotice(`RustDesk ${mode === 'control' ? 'control session' : 'file-transfer session'} launched for ${machine.name}${route ? ` via ${route}` : ''}.`)
  } catch (error) {
    // Native command errors arrive as plain strings.
    setNotice(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not start RustDesk session')
  }
}

export function RemoteBackground() {
  const config = useStore(configStore)
  const services = config.services
  const host = useStore(hostStore)

  // The host settings live in the config; the native side starts permissive (D15) until told.
  useEffect(() => {
    if (!isTauri()) return
    void remoteHostSettings(config.remote.allowControl, config.remote.askFirst).then(hostStore.set).catch(() => undefined)
  }, [config.remote.allowControl, config.remote.askFirst])
  usePeriodicRefresh(async () => { if (isTauri()) hostStore.set(await remoteHostStatus()) }, 2000, [])

  usePeriodicRefresh(async () => {
    // RustDesk runs whenever BridgeDeck does, so the paired computer can always connect.
    if (serviceConfig(configStore.get(), 'rustdesk')?.enabled) {
      try {
        const ensured = await rustDeskEnsureRunning(rustdeskExecutable())
        if (ensured.started) setNotice('Started RustDesk in the background so this computer can be controlled.')
      } catch { /* browser mode */ }
    }
    await refreshRustDeskIdentity()
  }, 15000, [services])

  // Always visible while this computer is being controlled.
  if (!host.sessions.length) return null
  const names = [...new Set(host.sessions.map(s => s.peerName))].join(', ')
  return <div className="remote-banner" role="alert"><span className="remote-live-dot"/><span><strong>{names}</strong> {host.sessions.length === 1 ? 'is' : 'are'} controlling this computer</span><button onClick={() => void stopHosting()}>Stop</button></div>
}
