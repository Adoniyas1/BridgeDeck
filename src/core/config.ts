import { defaultConfig, loadConfig, saveConfig } from '../lib/config'
import type { AppConfig, MachineConfig, ServiceConfig } from '../types'
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

export function updateMachine(id: MachineConfig['id'], patch: Partial<MachineConfig>) {
  setConfig(c => ({ ...c, machines: c.machines.map(m => m.id === id ? { ...m, ...patch } : m) }))
}

export function updateService(id: ServiceConfig['id'], patch: Partial<ServiceConfig>) {
  setConfig(c => ({ ...c, services: c.services.map(s => s.id === id ? { ...s, ...patch } : s) }))
}

export const serviceConfig = (config: AppConfig, id: ServiceConfig['id']) => config.services.find(s => s.id === id)
