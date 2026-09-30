import { useEffect } from 'react'
import {
  bridgeLinkStatus, pickTransferPaths, syncConflicts, syncSidecarAdopt, syncSidecarStart, syncSidecarStatus, syncthingFolders,
  syncthingRequest, syncthingSetupPeer, syncthingStatus,
} from '../../lib/bridge'
import { advertise, applyPairedPeer, bridgeLinkStore, refreshPeer } from '../../core/bridgelink'
import { configStore, serviceConfig, setConfig, updateDevice } from '../../core/config'
import { setNotice } from '../../core/notice'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { errorText } from '../../core/util'
import type {
  BridgeLinkPairedPeer, SyncConflict, SyncSidecarStatus, SyncthingAutoSetupResult, SyncthingFolder, SyncthingFolderStatus, SyncthingStatus,
} from '../../types'

export const syncthingStore = createStore<SyncthingStatus>({ ok: false })
export const syncthingFoldersStore = createStore<SyncthingFolder[]>([])
export const folderStatusStore = createStore<Record<string, SyncthingFolderStatus>>({})
export const conflictsStore = createStore<Record<string, SyncConflict[]>>({})
export const sidecarStore = createStore<SyncSidecarStatus>({ available: false, running: false, baseUrl: '', apiKey: '', home: '', detail: '' })
export const syncthingSetupStore = createStore<Record<string, SyncthingAutoSetupResult | { error: string }>>({})

const setSetup = (instanceId: string, value: SyncthingAutoSetupResult | { error: string }) =>
  syncthingSetupStore.set(current => ({ ...current, [instanceId]: value }))

const api = () => configStore.get().syncthing
/** One Syncthing REST call with the current address and key. */
export const rest = <T = unknown>(method: string, path: string, body?: unknown) => syncthingRequest<T>(api().baseUrl, api().apiKey, method, path, body)

/** Points the settings at the built-in Syncthing's address and key once it runs. */
function adoptSidecarAddress(status: SyncSidecarStatus) {
  sidecarStore.set(status)
  if (!status.running || !status.baseUrl) return
  setConfig(c => c.syncthing.baseUrl === status.baseUrl && c.syncthing.apiKey === status.apiKey ? c
    : { ...c, syncthing: { ...c.syncthing, baseUrl: status.baseUrl, apiKey: status.apiKey } })
}

export async function startBuiltIn() {
  try {
    adoptSidecarAddress(await syncSidecarStart())
  } catch (error) {
    sidecarStore.set({ ...sidecarStore.get(), running: false, detail: errorText(error, 'Could not start Syncthing') })
  }
}

/** Moves a separately installed Syncthing into BridgeDeck (same device ID, same folders). */
export async function adoptExisting(source: string) {
  try {
    setNotice('Moving Syncthing into BridgeDeck…')
    const { baseUrl, apiKey } = api()
    const status = await syncSidecarAdopt(source, baseUrl, apiKey)
    setConfig(c => ({ ...c, syncthing: { ...c.syncthing, mode: 'builtin' } }))
    adoptSidecarAddress(status)
    setNotice('Syncthing now runs inside BridgeDeck with the same device ID and folders. Remove the separate Syncthing app from your login items so it doesn\'t start again.')
    await refreshSyncthing()
  } catch (error) {
    setNotice(errorText(error, 'Could not move Syncthing into BridgeDeck'))
  }
}

export async function refreshSyncthing() {
  const { syncthing } = configStore.get()
  if (syncthing.mode === 'builtin') {
    try { adoptSidecarAddress(await syncSidecarStatus()) } catch { /* browser mode */ }
  }
  if (serviceConfig(configStore.get(), 'syncthing')?.enabled && syncthing.apiKey) {
    try {
      const status = await syncthingStatus(syncthing.baseUrl, syncthing.apiKey)
      syncthingStore.set(status)
      if (status.myID) advertise({ syncthingId: status.myID })
    } catch {
      syncthingStore.set({ ok: false })
    }
  }
  if (syncthing.apiKey && syncthing.baseUrl) {
    try {
      const folders = await syncthingFolders(syncthing.baseUrl, syncthing.apiKey)
      syncthingFoldersStore.set(folders)
      const statuses = await Promise.all(folders.map(async f => [f.id, await rest<SyncthingFolderStatus>('GET', `/rest/db/status?folder=${encodeURIComponent(f.id)}`).catch(() => ({}))] as const))
      folderStatusStore.set(Object.fromEntries(statuses))
    } catch {
      syncthingFoldersStore.set([])
    }
  }
}

export async function scanConflicts() {
  const folders = syncthingFoldersStore.get().filter(f => f.path)
  const found = await Promise.all(folders.map(async f => [f.id, await syncConflicts(f.path!).catch(() => [])] as const))
  conflictsStore.set(Object.fromEntries(found))
}

export async function setFolderPaused(folder: SyncthingFolder, paused: boolean) {
  try {
    await rest('PATCH', `/rest/config/folders/${encodeURIComponent(folder.id)}`, { paused })
    await refreshSyncthing()
  } catch (error) {
    setNotice(errorText(error, 'Could not change the folder'))
  }
}

/** Stops syncing a folder (its files stay on this computer). */
export async function removeFolder(folder: SyncthingFolder) {
  try {
    await rest('DELETE', `/rest/config/folders/${encodeURIComponent(folder.id)}`)
    setNotice(`${folder.label || folder.id} is no longer synced. Its files are still on this computer.`)
    await refreshSyncthing()
  } catch (error) {
    setNotice(errorText(error, 'Could not remove the folder'))
  }
}

/** Picks a folder on this computer and shares it with every paired device Syncthing knows. */
export async function addFolder() {
  try {
    const [path] = await pickTransferPaths(true)
    if (!path) return
    const status = await rest<{ myID: string }>('GET', '/rest/system/status')
    const template = await rest<Record<string, unknown>>('GET', '/rest/config/defaults/folder')
    const label = path.split(/[\\/]/).filter(Boolean).pop() || 'Shared folder'
    const id = `bridgedeck-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'folder'}-${Math.random().toString(36).slice(2, 7)}`
    const peers = bridgeLinkStore.get().paired.map(p => p.syncthingDeviceId).filter((d): d is string => !!d)
    const devices = [status.myID, ...peers].map(deviceID => ({ deviceID }))
    await rest('POST', '/rest/config/folders', { ...template, id, label, path, type: 'sendreceive', devices })
    setNotice(`Sharing ${label} with ${peers.length ? `${peers.length} paired device${peers.length === 1 ? '' : 's'}` : 'no one yet (pair a device and set up sync)'}. Accept it on the other computer's Sync tab if asked.`)
    await refreshSyncthing()
  } catch (error) {
    setNotice(errorText(error, 'Could not add the folder'))
  }
}

/** Adds the paired computer to local Syncthing and shares the BridgeDeck folder with it. */
export async function configureSyncthingPeer(originalPeer: BridgeLinkPairedPeer) {
  const { syncthing } = configStore.get()
  if (!syncthing.autoSetup) return
  if (!syncthing.apiKey.trim()) {
    setSetup(originalPeer.instanceId, { error: syncthing.mode === 'builtin' ? 'Waiting for the built-in Syncthing to start…' : 'Add the local Syncthing API key in Settings to enable automatic shared-folder setup.' })
    return
  }
  let peer = originalPeer
  try {
    if (!peer.syncthingDeviceId) {
      const refreshed = await refreshPeer(peer.instanceId)
      if (refreshed) {
        peer = refreshed
        applyPairedPeer(peer)
        bridgeLinkStore.set(await bridgeLinkStatus())
      }
    }
    if (!peer.syncthingDeviceId) throw new Error('The paired computer has not reported a Syncthing device ID yet. Make sure Syncthing is running there, then use Setup sync again.')
    setSetup(peer.instanceId, { error: 'Configuring Syncthing…' })
    const result = await syncthingSetupPeer({
      baseUrl: syncthing.baseUrl,
      apiKey: syncthing.apiKey,
      peerDeviceId: peer.syncthingDeviceId,
      peerName: peer.name,
      folderId: syncthing.sharedFolderId,
      folderLabel: syncthing.sharedFolderLabel,
      folderPath: syncthing.sharedFolderPath,
      peerHost: peer.host,
    })
    setSetup(peer.instanceId, result)
    updateDevice(peer.instanceId, { syncthingDeviceId: peer.syncthingDeviceId, sharedPath: result.folderPath })
    syncthingFoldersStore.set(await syncthingFolders(syncthing.baseUrl, syncthing.apiKey))
    setNotice(result.detail)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automatic Syncthing setup failed'
    setSetup(originalPeer.instanceId, { error: message })
    setNotice(message)
  }
}

/** The address each paired device had when its Syncthing entry was last set up. */
const setupHosts = new Map<string, string>()

export function SyncBackground() {
  const config = useStore(configStore)
  const syncthing = useStore(syncthingStore)
  const paired = useStore(bridgeLinkStore).paired

  // The built-in Syncthing starts with BridgeDeck (and BridgeDeck restarts it if it stops).
  useEffect(() => {
    if (config.syncthing.mode === 'builtin' && serviceConfig(configStore.get(), 'syncthing')?.enabled) void startBuiltIn()
  }, [config.syncthing.mode])

  usePeriodicRefresh(refreshSyncthing, 15000, [config.services, config.syncthing])

  // Newly paired computers (and every paired computer at start-up) get the shared folder automatically.
  // Results for forgotten computers are dropped, so pairing one again sets it up again. A device whose
  // address changed (for example it's now reached over Tailscale) is set up again with the new address.
  const pairedIds = paired.map(peer => `${peer.instanceId}@${peer.host}`).sort().join(',')
  useEffect(() => {
    const ids = new Set(paired.map(p => p.instanceId))
    const moved = new Set(paired.filter(p => setupHosts.has(p.instanceId) && setupHosts.get(p.instanceId) !== p.host).map(p => p.instanceId))
    paired.forEach(p => setupHosts.set(p.instanceId, p.host))
    syncthingSetupStore.set(current => Object.keys(current).every(id => ids.has(id) && !moved.has(id)) ? current
      : Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id) && !moved.has(id))))
    if (!config.syncthing.autoSetup || !config.syncthing.apiKey.trim() || !syncthing.ok || !paired.length) return
    const done = syncthingSetupStore.get()
    paired.forEach(peer => {
      if (!done[peer.instanceId]) void configureSyncthingPeer(peer)
    })
  }, [config.syncthing.autoSetup, config.syncthing.apiKey, syncthing.ok, pairedIds])

  return null
}
