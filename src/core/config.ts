import { blankDevice, defaultConfig, loadConfig, saveConfig } from '../lib/config'
import type { AppConfig, DeviceConfig, ServiceConfig } from '../types'
import { createStore, useStore } from './store'

export const configStore = createStore<AppConfig>(defaultConfig)
/** False until the saved config has been loaded; features start their background work after that. */
export const hydratedStore = createStore(false)

export const setConfig = configStore.set
export const useConfig = () => useStore(configStore)

let hydrating = false

export async function hydrateConfig() {
  if (hydrating) return
  hydrating = true
  configStore.set(await loadConfig())
  hydratedStore.set(true)
  configStore.subscribe(() => void saveConfig(configStore.get()))
}

export function updateDevice(id: string, patch: Partial<DeviceConfig>) {
  setConfig(c => ({ ...c, devices: c.devices.map(d => d.id === id ? { ...d, ...patch } : d) }))
}

/** Applies `patch` to the device with this id, or adds it using `created` for its name, platform and
 *  whether it is this computer. Leaves config untouched when nothing would change (BridgeLink calls this
 *  on every refresh), and never overwrites a name the user changed. */
export function upsertDevice(id: string, patch: Partial<DeviceConfig>, created: Pick<DeviceConfig, 'name' | 'platform' | 'local'>) {
  setConfig(c => {
    const existing = c.devices.find(d => d.id === id)
    if (!existing) return { ...c, devices: [...c.devices, { ...blankDevice, ...created, ...patch, id }] }
    if (Object.entries(patch).every(([key, value]) => existing[key as keyof DeviceConfig] === value)) return c
    return { ...c, devices: c.devices.map(d => d.id === id ? { ...d, ...patch } : d) }
  })
}

export function removeDevice(id: string) {
  setConfig(c => ({ ...c, devices: c.devices.filter(d => d.id !== id) }))
}

/** This computer first, then the others in the order they were added. */
export const sortedDevices = (devices: DeviceConfig[]) => [...devices.filter(d => d.local), ...devices.filter(d => !d.local)]

export function updateService(id: ServiceConfig['id'], patch: Partial<ServiceConfig>) {
  setConfig(c => ({ ...c, services: c.services.map(s => s.id === id ? { ...s, ...patch } : s) }))
}

export const serviceConfig = (config: AppConfig, id: ServiceConfig['id']) => config.services.find(s => s.id === id)
