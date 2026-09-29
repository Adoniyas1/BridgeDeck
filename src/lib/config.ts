import type { AppConfig } from '../types'
import { loadNativeConfig, saveNativeConfig } from './bridge'

export const defaultConfig: AppConfig = {
  configVersion: 7,
  machines: [
    { id: 'mac', name: 'Mac', agentUrl: 'http://127.0.0.1:4141', agentToken: '', rustdeskPeerId: '', localsendTarget: '', localsendPin: '', sharedPath: '', bridgeInstanceId: '', syncthingDeviceId: '' },
    { id: 'windows', name: 'Windows', agentUrl: 'http://127.0.0.1:4142', agentToken: '', rustdeskPeerId: '', localsendTarget: '', localsendPin: '', sharedPath: '', bridgeInstanceId: '', syncthingDeviceId: '' },
  ],
  services: [
    { id: 'rustdesk', name: 'RustDesk', enabled: true, autoStart: false, notes: 'Two-way remote control' },
    { id: 'bluebubbles', name: 'BlueBubbles', enabled: true, autoStart: false, host: '127.0.0.1', port: 1234, notes: 'iMessage bridge from the Mac' },
    { id: 'syncthing', name: 'Syncthing', enabled: true, autoStart: false, host: '127.0.0.1', port: 8384, webUrl: 'http://127.0.0.1:8384', notes: 'Persistent shared folders' },
    { id: 'matrix', name: 'Matrix', enabled: true, autoStart: false, notes: 'AI and human message transport' },
    { id: 'localsend', name: 'LocalSend', enabled: true, autoStart: false, notes: 'Quick file transfers' },
  ],
  matrix: { homeserver: '', roomId: '', accessToken: '' },
  bluebubbles: { baseUrl: '', password: '' },
  syncthing: { baseUrl: 'http://127.0.0.1:8384', apiKey: '', autoSetup: true, sharedFolderId: 'bridgedeck-shared', sharedFolderLabel: 'BridgeDeck Shared', sharedFolderPath: '' },
  localsend: { alias: 'BridgeDeck', destination: '', port: 53317, pin: '', autoAccept: false },
  pairing: { displayName: '', apiPort: 41416, autoStart: true },
}

const KEY = 'bridgedeck.config.v7'

function mergeConfig(input: Partial<AppConfig> | null | undefined): AppConfig {
  if (!input) return structuredClone(defaultConfig)
  const services = defaultConfig.services.map(base => ({ ...base, ...(input.services?.find(s => s.id === base.id) || {}) }))
  const machines = defaultConfig.machines.map(base => ({ ...base, ...(input.machines?.find(m => m.id === base.id) || {}) }))
  return {
    ...defaultConfig,
    ...input,
    configVersion: 7,
    machines,
    services,
    matrix: { ...defaultConfig.matrix, ...(input.matrix || {}) },
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
    // Browser mode or an unreadable native config falls back to localStorage.
  }
  try {
    const legacy = localStorage.getItem('bridgedeck.config.v6') || localStorage.getItem('bridgedeck.config.v5') || localStorage.getItem('bridgedeck.config.v4') || localStorage.getItem('bridgedeck.config.v3')
    const raw = localStorage.getItem(KEY) || legacy
    return mergeConfig(raw ? JSON.parse(raw) as Partial<AppConfig> : null)
  } catch {
    return structuredClone(defaultConfig)
  }
}

export async function saveConfig(config: AppConfig) {
  const raw = JSON.stringify(config)
  localStorage.setItem(KEY, raw)
  try { await saveNativeConfig(raw) } catch { /* browser mode */ }
}
