import { useEffect } from 'react'
import { appAvailable, managedServiceStart, managedServiceStatus, managedServiceStop, probeTcp } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { setNotice } from '../../core/notice'
import { refreshAll, usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import type { ManagedServiceState, ServiceConfig, ServiceKey } from '../../types'
import { receiverStore } from '../files/state'
import { syncthingStore } from '../sync/state'

export const serviceIds: ServiceKey[] = ['rustdesk', 'syncthing', 'localsend']

export const managedStore = createStore<Record<string, ManagedServiceState>>({})
/** Reachability checks (TCP probe, installed app); see `useServiceReady` for the full answer. */
export const probeStore = createStore<Record<string, boolean>>({})

/** A service is ready when its probe succeeds, BridgeDeck manages a running copy, or (Syncthing,
 *  LocalSend) its own feature reports it running. */
export function useServiceReady(): Record<string, boolean> {
  const probes = useStore(probeStore)
  const managed = useStore(managedStore)
  const syncthingOk = useStore(syncthingStore).ok
  const receiverRunning = useStore(receiverStore).running
  return Object.fromEntries(serviceIds.map(id => [id,
    !!probes[id] || !!managed[id]?.running || (id === 'syncthing' && syncthingOk) || (id === 'localsend' && receiverRunning),
  ]))
}

async function refreshServices() {
  const config = configStore.get()
  const managedPairs = await Promise.all(config.services.map(async s => [s.id, await managedServiceStatus(s.id, s.executable)] as const))
  managedStore.set(Object.fromEntries(managedPairs))

  const next: Record<string, boolean> = {}
  for (const service of config.services) {
    if (!service.enabled || service.id === 'localsend') { next[service.id] = false; continue }
    try {
      if (service.host && service.port) {
        next[service.id] = await probeTcp(service.host, service.port)
      } else {
        next[service.id] = await appAvailable(service.id, service.executable)
      }
    } catch {
      next[service.id] = false
    }
  }
  probeStore.set(next)
}

export async function startService(service: ServiceConfig) {
  try {
    setNotice(`Starting ${service.name}…`)
    await managedServiceStart(service.id, service.executable)
    await refreshAll()
    setNotice(`${service.name} started and is now tracked by BridgeDeck.`)
  } catch (error) {
    setNotice(error instanceof Error ? error.message : `Could not start ${service.name}`)
  }
}

export async function stopService(service: ServiceConfig) {
  try {
    setNotice(`Stopping ${service.name}…`)
    await managedServiceStop(service.id)
    await refreshAll()
    setNotice(`${service.name} stopped.`)
  } catch (error) {
    setNotice(error instanceof Error ? error.message : `Could not stop ${service.name}`)
  }
}

export function ServicesBackground() {
  const config = useStore(configStore)

  // Services marked auto-start are launched once per app start.
  useEffect(() => {
    const targets = configStore.get().services.filter(s => s.enabled && s.autoStart && s.id !== 'localsend')
    if (!targets.length) return
    void Promise.all(targets.map(async s => {
      try { await managedServiceStart(s.id, s.executable) } catch { /* surfaced on Services */ }
    })).then(() => refreshAll())
  }, [])

  usePeriodicRefresh(refreshServices, 15000, [config.services])
  return null
}
