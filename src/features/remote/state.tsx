import { useEffect } from 'react'
import { isTauri, remoteHostSettings, remoteHostStatus, remoteHostStop, type RemoteHostStatus } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { setNotice } from '../../core/notice'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { openTab } from '../../core/tabs'

/** This computer as a remote-control host: supported, settings, who's controlling it now. */
export const hostStore = createStore<RemoteHostStatus>({ supported: false, settings: { allow: true, askFirst: false }, sessions: [] })

/** Opens (or shows) the tab controlling a paired device. */
export function controlDevice(device: { id: string; name: string }) {
  openTab({ id: `remote:${device.id}`, kind: 'remote-session', title: device.name, params: { peer: device.id, name: device.name } })
}

export async function stopHosting() {
  try { hostStore.set(await remoteHostStop()) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
}

export function RemoteBackground() {
  const config = useStore(configStore)
  const host = useStore(hostStore)

  // The host settings live in the config; the native side starts permissive (D15) until told.
  useEffect(() => {
    if (!isTauri()) return
    void remoteHostSettings(config.remote.allowControl, config.remote.askFirst, config.remote.askDevices).then(hostStore.set).catch(() => undefined)
  }, [config.remote.allowControl, config.remote.askFirst, config.remote.askDevices.join(',')])
  usePeriodicRefresh(async () => { if (isTauri()) hostStore.set(await remoteHostStatus()) }, 2000, [])

  // Always visible while this computer is being controlled.
  if (!host.sessions.length) return null
  const names = [...new Set(host.sessions.map(s => s.peerName))].join(', ')
  return <div className="remote-banner" role="alert"><span className="remote-live-dot"/><span><strong>{names}</strong> {host.sessions.length === 1 ? 'is' : 'are'} controlling this computer</span><button onClick={() => void stopHosting()}>Stop</button></div>
}
