import { useEffect } from 'react'
import { bridgeLinkStatus, syncthingFolders, syncthingSetupPeer, syncthingStatus } from '../../lib/bridge'
import { advertise, applyPairedPeer, bridgeLinkStore, refreshPeer } from '../../core/bridgelink'
import { configStore, serviceConfig, updateDevice } from '../../core/config'
import { setNotice } from '../../core/notice'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import type { BridgeLinkPairedPeer, SyncthingAutoSetupResult, SyncthingFolder, SyncthingStatus } from '../../types'

export const syncthingStore = createStore<SyncthingStatus>({ ok: false })
export const syncthingFoldersStore = createStore<SyncthingFolder[]>([])
export const syncthingSetupStore = createStore<Record<string, SyncthingAutoSetupResult | { error: string }>>({})

const setSetup = (instanceId: string, value: SyncthingAutoSetupResult | { error: string }) =>
  syncthingSetupStore.set(current => ({ ...current, [instanceId]: value }))

export async function refreshSyncthing() {
  const { syncthing } = configStore.get()
  if (serviceConfig(configStore.get(), 'syncthing')?.enabled) {
    try {
      const status = await syncthingStatus(syncthing.baseUrl, syncthing.apiKey)
      syncthingStore.set(status)
      if (status.myID) advertise({ syncthingId: status.myID })
    } catch {
      syncthingStore.set({ ok: false })
    }
  }
  if (syncthing.apiKey && syncthing.baseUrl) {
    try { syncthingFoldersStore.set(await syncthingFolders(syncthing.baseUrl, syncthing.apiKey)) } catch { syncthingFoldersStore.set([]) }
  }
}

/** Adds the paired computer to local Syncthing and shares the BridgeDeck folder with it. */
export async function configureSyncthingPeer(originalPeer: BridgeLinkPairedPeer) {
  const { syncthing } = configStore.get()
  if (!syncthing.autoSetup) return
  if (!syncthing.apiKey.trim()) {
    setSetup(originalPeer.instanceId, { error: 'Add the local Syncthing API key in Settings to enable automatic shared-folder setup.' })
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

export function SyncBackground() {
  const config = useStore(configStore)
  const syncthing = useStore(syncthingStore)
  const paired = useStore(bridgeLinkStore).paired

  usePeriodicRefresh(refreshSyncthing, 15000, [config.services, config.syncthing])

  // Newly paired computers (and every paired computer at start-up) get the shared folder automatically.
  // Results for forgotten computers are dropped, so pairing one again sets it up again.
  const pairedIds = paired.map(peer => peer.instanceId).sort().join(',')
  useEffect(() => {
    const ids = new Set(pairedIds.split(','))
    syncthingSetupStore.set(current => Object.keys(current).every(id => ids.has(id)) ? current
      : Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))))
    if (!config.syncthing.autoSetup || !config.syncthing.apiKey.trim() || !syncthing.ok || !paired.length) return
    const done = syncthingSetupStore.get()
    paired.forEach(peer => {
      if (!done[peer.instanceId]) void configureSyncthingPeer(peer)
    })
  }, [config.syncthing.autoSetup, config.syncthing.apiKey, syncthing.ok, pairedIds])

  return null
}
