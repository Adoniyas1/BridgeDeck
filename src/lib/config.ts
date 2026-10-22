import type { AppConfig, DeviceConfig } from '../types'
import { isTauri, loadNativeConfig, saveNativeConfig } from './bridge'

export const blankDevice: Omit<DeviceConfig, 'id' | 'name' | 'platform' | 'local'> = {
  agentUrl: '', agentToken: '', localsendTarget: '', localsendPin: '', sharedPath: '', syncthingDeviceId: '',
}

export const defaultConfig: AppConfig = {
  configVersion: 8,
  // This computer and paired peers are added by BridgeLink as it learns about them.
  devices: [],
  services: [
    { id: 'syncthing', name: 'Syncthing', enabled: true, autoStart: false, host: '127.0.0.1', port: 8384, webUrl: 'http://127.0.0.1:8384', notes: 'Persistent shared folders' },
    { id: 'localsend', name: 'LocalSend', enabled: true, autoStart: false, notes: 'Quick file transfers' },
  ],
  remote: { allowControl: true, askFirst: false, askDevices: [] },
  clipboard: { sync: true, history: true },
  notifications: { messages: true, ai: true, files: true, sync: true, updates: true, reminders: true, mail: true },
  mail: { accounts: [], background: true },
  phone: { enabled: false },
  updates: { auto: false },
  mimir: { enabled: false },
  calendar: { showApple: false, weekStart: 0, defaultReminder: 10, feeds: [] },
  brief: { morning: true, morningAt: '08:00', evening: true, eveningAt: '19:00', away: true },
  tv: { shortcuts: [] },
  browsing: { adblock: true, allowAds: [], annoyances: true, popups: true, popupSites: [], bookmarks: [], sleepMinutes: 15 },
  study: { ocrLanguages: [], examBlock: ['youtube.com', 'netflix.com', 'tiktok.com', 'instagram.com', 'reddit.com', 'x.com', 'twitter.com', 'facebook.com', 'twitch.tv', 'hulu.com', 'disneyplus.com', 'max.com'], quietFocus: true, classRemindMinutes: 15, commuteMinutes: 30 },
  canvas: { base: '', feed: '', token: '', remindHours: 24, done: [], added: [] },
  setup: { dismissed: false, notificationsReviewed: false },
  sendTo: { enabled: true },
  syncthing: { mode: 'builtin', baseUrl: 'http://127.0.0.1:8384', apiKey: '', autoSetup: true, sharedFolderId: 'bridgedeck-shared', sharedFolderLabel: 'BridgeDeck Shared', sharedFolderPath: '' },
  localsend: { alias: 'BridgeDeck', destination: '', port: 53317, pin: '', autoAccept: false },
  pairing: { displayName: '', apiPort: 41416, autoStart: true },
  messages: { nicknames: {} },
}

/** Browser dev mode keeps settings in localStorage. The app itself stores them natively (secrets in the
 *  OS credential store) and removes the copies older builds left in localStorage. */
const KEY = 'bridgedeck.config.v7'
const BROWSER_KEYS = [KEY, 'bridgedeck.config.v6', 'bridgedeck.config.v5', 'bridgedeck.config.v4', 'bridgedeck.config.v3']

/** v7 and earlier had two fixed slots, `machines: [{ id: 'mac' }, { id: 'windows' }]`. Configured slots
 *  become devices keyed by their BridgeLink instance ID (or `manual-mac`/`manual-windows`); untouched
 *  default slots are dropped. */
type LegacyMachine = Omit<DeviceConfig, 'id' | 'platform' | 'local'> & { id: 'mac' | 'windows'; bridgeInstanceId?: string; rustdeskPeerId?: string }

const isLoopbackUrl = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)

export function migrateMachines(machines: LegacyMachine[]): DeviceConfig[] {
  return machines.flatMap(machine => {
    const defaultAgent = machine.agentUrl === (machine.id === 'mac' ? 'http://127.0.0.1:4141' : 'http://127.0.0.1:4142')
    const configured = machine.bridgeInstanceId || machine.rustdeskPeerId || machine.localsendTarget || machine.sharedPath
      || machine.syncthingDeviceId || machine.agentToken || (machine.agentUrl && !defaultAgent)
    if (!configured) return []
    return [{
      ...blankDevice,
      agentUrl: machine.agentUrl || '', agentToken: machine.agentToken || '',
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
  // Services missing from defaultConfig (Matrix after 0.7, RustDesk after 0.9) are dropped here.
  const services = defaultConfig.services.map(base => ({ ...base, ...(input.services?.find(s => s.id === base.id) || {}) }))
  // Matrix (0.8) and BlueBubbles (0.9: Messages are read by BridgeDeck on the Mac) are gone.
  const { matrix: _removedMatrix, bluebubbles: _removedBlueBubbles, machines, ...rest } = input as Partial<AppConfig> & { matrix?: unknown; bluebubbles?: unknown; machines?: LegacyMachine[] }
  const devices = Array.isArray(input.devices)
    // RustDesk peer IDs (0.9 and older) are dropped: remote control is built in.
    ? input.devices.map(device => { const { rustdeskPeerId: _removed, ...rest } = device as DeviceConfig & { rustdeskPeerId?: string }; return { ...blankDevice, ...rest } })
    : migrateMachines(machines ?? [])
  return {
    ...defaultConfig,
    ...rest,
    configVersion: 8,
    devices,
    services,
    // Existing setups keep their separately installed Syncthing until the user moves it into BridgeDeck.
    syncthing: { ...defaultConfig.syncthing, mode: input.syncthing?.apiKey ? 'external' : 'builtin', ...(input.syncthing || {}) },
    remote: { ...defaultConfig.remote, ...(input.remote || {}) },
    clipboard: { ...defaultConfig.clipboard, ...(input.clipboard || {}) },
    notifications: { ...defaultConfig.notifications, ...(input.notifications || {}) },
    sendTo: { ...defaultConfig.sendTo, ...(input.sendTo || {}) },
    phone: { enabled: input.phone?.enabled === true },
    updates: { ...defaultConfig.updates, ...(input.updates || {}) },
    mimir: { ...defaultConfig.mimir, ...(input.mimir || {}) },
    calendar: {
      ...defaultConfig.calendar, ...(input.calendar || {}),
      feeds: Array.isArray(input.calendar?.feeds) ? input.calendar.feeds.filter(f => f && typeof f.url === 'string' && /^(https|webcal):\/\//.test(f.url) && /^[a-z0-9]{1,12}$/.test(String(f.id))).map(f => ({ id: f.id, name: String(f.name || 'Calendar').slice(0, 40), url: f.url, color: String(f.color || 'purple') })).slice(0, 10) : [],
    },
    brief: { ...defaultConfig.brief, ...(input.brief || {}) },
    tv: { shortcuts: cleanShortcuts(input.tv?.shortcuts) },
    study: {
      ocrLanguages: Array.isArray(input.study?.ocrLanguages) ? input.study.ocrLanguages.filter((l): l is string => typeof l === 'string' && /^[a-z_]{3,8}$/.test(l)).slice(0, 12) : [],
      examBlock: Array.isArray(input.study?.examBlock) ? cleanSites(input.study.examBlock) : [...defaultConfig.study.examBlock],
      quietFocus: input.study?.quietFocus !== false,
      commuteMinutes: Number.isFinite(input.study?.commuteMinutes) ? Math.max(0, Math.min(240, Math.round(Number(input.study!.commuteMinutes)))) : defaultConfig.study.commuteMinutes,
      classRemindMinutes: Number.isFinite(input.study?.classRemindMinutes) ? Math.max(0, Math.min(120, Math.round(Number(input.study!.classRemindMinutes)))) : defaultConfig.study.classRemindMinutes,
    },
    canvas: {
      base: typeof input.canvas?.base === 'string' ? input.canvas.base : '',
      feed: typeof input.canvas?.feed === 'string' ? input.canvas.feed : '',
      token: typeof input.canvas?.token === 'string' ? input.canvas.token : '',
      remindHours: Number.isFinite(input.canvas?.remindHours) ? Math.max(0, Math.min(168, Number(input.canvas!.remindHours))) : defaultConfig.canvas.remindHours,
      done: Array.isArray(input.canvas?.done) ? input.canvas.done.filter((d): d is string => typeof d === 'string').slice(-500) : [],
      added: Array.isArray(input.canvas?.added) ? input.canvas.added.filter((d): d is string => typeof d === 'string').slice(-200) : [],
    },
    mail: {
      accounts: Array.isArray(input.mail?.accounts) ? input.mail.accounts.filter(a => a && /^[a-z0-9]{1,12}$/.test(a.id) && typeof a.url === 'string' && /^https:\/\//.test(a.url)).map(a => ({ id: a.id, name: String(a.name || 'Mail').slice(0, 40), url: a.url })).slice(0, 8) : [],
      background: input.mail?.background !== false,
    },
    browsing: {
      adblock: input.browsing?.adblock !== false,
      allowAds: cleanSites(input.browsing?.allowAds),
      annoyances: input.browsing?.annoyances !== false,
      popups: input.browsing?.popups !== false,
      popupSites: cleanSites(input.browsing?.popupSites),
      bookmarks: cleanShortcuts(input.browsing?.bookmarks, 200),
      sleepMinutes: [0, 5, 15, 30, 60].includes(Number(input.browsing?.sleepMinutes)) ? Number(input.browsing!.sleepMinutes) : 15,
    },
    // Setups from before the checklist existed are already set up.
    setup: input.setup ? { ...defaultConfig.setup, ...input.setup } : { dismissed: devices.length > 1, notificationsReviewed: false },
    localsend: { ...defaultConfig.localsend, ...(input.localsend || {}) },
    pairing: { ...defaultConfig.pairing, ...(input.pairing || {}) },
    messages: { nicknames: { ...(input.messages?.nicknames || {}) } },
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

/** Stored TV shortcuts: web addresses only, named, at most 40. */
/** Stored site lists (ads or pop-ups allowed): host names only, at most 200. */
function cleanSites(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string').slice(0, 200) : []
}

export function cleanShortcuts(list: unknown, max = 40): Array<{ name: string; url: string }> {
  if (!Array.isArray(list)) return []
  return list.flatMap(item => {
    const url = typeof item?.url === 'string' ? item.url.trim() : ''
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 80) : ''
    return /^https?:\/\/[^\s]+$/i.test(url) && name ? [{ name, url }] : []
  }).slice(0, max)
}
