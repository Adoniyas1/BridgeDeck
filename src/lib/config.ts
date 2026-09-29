import type { AppConfig, DeviceConfig } from '../types'
import { isTauri, loadNativeConfig, saveNativeConfig } from './bridge'

export const blankDevice: Omit<DeviceConfig, 'id' | 'name' | 'platform' | 'local'> = {
  agentUrl: '', agentToken: '', rustdeskPeerId: '', localsendTarget: '', localsendPin: '', sharedPath: '', syncthingDeviceId: '',
}

export const defaultConfig: AppConfig = {
  configVersion: 8,
  // This computer and paired peers are added by BridgeLink as it learns about them.
  devices: [],
  services: [
    { id: 'rustdesk', name: 'RustDesk', enabled: true, autoStart: false, notes: 'Two-way remote control' },
    { id: 'bluebubbles', name: 'BlueBubbles', enabled: true, autoStart: false, host: '127.0.0.1', port: 1234, notes: 'iMessage bridge from the Mac' },
    { id: 'syncthing', name: 'Syncthing', enabled: true, autoStart: false, host: '127.0.0.1', port: 8384, webUrl: 'http://127.0.0.1:8384', notes: 'Persistent shared folders' },
    { id: 'localsend', name: 'LocalSend', enabled: true, autoStart: false, notes: 'Quick file transfers' },
  ],
  bluebubbles: { baseUrl: '', password: '' },
  syncthing: { baseUrl: 'http://127.0.0.1:8384', apiKey: '', autoSetup: true, sharedFolderId: 'bridgedeck-shared', sharedFolderLabel: 'BridgeDeck Shared', sharedFolderPath: '' },
  localsend: { alias: 'BridgeDeck', destination: '', port: 53317, pin: '', autoAccept: false },
  pairing: { displayName: '', apiPort: 41416, autoStart: true },
}

/** Browser dev mode keeps settings in localStorage. The app itself stores them natively (secrets in the
 *  OS credential store) and removes the copies older builds left in localStorage. */
const KEY = 'bridgedeck.config.v7'
const BROWSER_KEYS = [KEY, 'bridgedeck.config.v6', 'bridgedeck.config.v5', 'bridgedeck.config.v4', 'bridgedeck.config.v3']

/** v7 and earlier had two fixed slots, `machines: [{ id: 'mac' }, { id: 'windows' }]`. Configured slots
 *  become devices keyed by their BridgeLink instance ID (or `manual-mac`/`manual-windows`); untouched
 *  default slots are dropped. */
type LegacyMachine = Omit<DeviceConfig, 'id' | 'platform' | 'local'> & { id: 'mac' | 'windows'; bridgeInstanceId?: string }

const isLoopbackUrl = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)

export function migrateMachines(machines: LegacyMachine[]): DeviceConfig[] {
  return machines.flatMap(machine => {
    const defaultAgent = machine.agentUrl === (machine.id === 'mac' ? 'http://127.0.0.1:4141' : 'http://127.0.0.1:4142')
    const configured = machine.bridgeInstanceId || machine.rustdeskPeerId || machine.localsendTarget || machine.sharedPath
      || machine.syncthingDeviceId || machine.agentToken || (machine.agentUrl && !defaultAgent)
    if (!configured) return []
    return [{
      ...blankDevice,
      agentUrl: machine.agentUrl || '', agentToken: machine.agentToken || '', rustdeskPeerId: machine.rustdeskPeerId || '',
      localsendTarget: machine.localsendTarget || '', localsendPin: machine.localsendPin || '', sharedPath: machine.sharedPath || '',
      syncthingDeviceId: machine.syncthingDeviceId || '',
      id: machine.bridgeInstanceId || `manual-${machine.id}`,
      name: machine.name || (machine.id === 'mac' ? 'Mac' : 'Windows'),
      platform: machine.id === 'mac' ? 'macos' : 'windows',
      // The slot BridgeLink filled for this computer points at the local API.
      local: Boolean(machine.bridgeInstanceId) && isLoopbackUrl(machine.agentUrl),
    }]
  })
}

export function mergeConfig(input: Partial<AppConfig> | null | undefined): AppConfig {
  if (!input) return structuredClone(defaultConfig)
  // Services missing from defaultConfig (Matrix, removed after v0.7) are dropped here.
  const services = defaultConfig.services.map(base => ({ ...base, ...(input.services?.find(s => s.id === base.id) || {}) }))
  const { matrix: _removedMatrix, machines, ...rest } = input as Partial<AppConfig> & { matrix?: unknown; machines?: LegacyMachine[] }
  const devices = Array.isArray(input.devices)
    ? input.devices.map(device => ({ ...blankDevice, ...device }))
    : migrateMachines(machines ?? [])
  return {
    ...defaultConfig,
    ...rest,
    configVersion: 8,
    devices,
    services,
    bluebubbles: { ...defaultConfig.bluebubbles, ...(input.bluebubbles || {}) },
    syncthing: { ...defaultConfig.syncthing, ...(input.syncthing || {}) },
    localsend: { ...defaultConfig.localsend, ...(input.localsend || {}) },
    pairing: { ...defaultConfig.pairing, ...(input.pairing || {}) },
  }
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const native = await loadNativeConfig()
    if (native) return mergeConfig(JSON.parse(native) as Partial<AppConfig>)
  } catch {
    // An unreadable native config falls back to what older builds left in localStorage.
  }
  try {
    const raw = BROWSER_KEYS.map(key => localStorage.getItem(key)).find(Boolean)
    return mergeConfig(raw ? JSON.parse(raw) as Partial<AppConfig> : null)
  } catch {
    return structuredClone(defaultConfig)
  }
}

export async function saveConfig(config: AppConfig) {
  const raw = JSON.stringify(config)
  if (!isTauri()) {
    localStorage.setItem(KEY, raw)
    return
  }
  await saveNativeConfig(raw)
  try { BROWSER_KEYS.forEach(key => localStorage.removeItem(key)) } catch { /* storage unavailable */ }
}
