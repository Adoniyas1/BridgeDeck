import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isTauri, trayUpdate, type TrayPeer } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { configStore, setConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { addTransferPaths, clearTransferPaths, sendWithLocalSend, transferPathsStore } from '../files/state'
import { controlDevice } from '../remote/state'

type TrayAction = { action: 'control' | 'send'; peer: string } | { action: 'clipboard' }

const canHost = (platform: string) => platform === 'macos' || platform === 'windows'

/** The tray menu's device lists, from the paired computers and their settings. */
export function trayPeers(paired: Array<{ instanceId: string; name: string; platform: string }>, devices: Array<{ id: string; localsendTarget: string }>): TrayPeer[] {
  return paired.map(peer => ({
    id: peer.instanceId,
    name: peer.name,
    canControl: canHost(peer.platform),
    canReceive: !!devices.find(d => d.id === peer.instanceId)?.localsendTarget,
  }))
}

async function run(action: TrayAction) {
  if (action.action === 'clipboard') {
    setConfig(c => ({ ...c, clipboard: { ...c.clipboard, sync: !c.clipboard.sync } }))
    return
  }
  const peer = bridgeLinkStore.get().paired.find(p => p.instanceId === action.peer)
  if (!peer) return
  if (action.action === 'control') {
    controlDevice({ id: peer.instanceId, name: peer.name })
    return
  }
  const device = configStore.get().devices.find(d => d.id === peer.instanceId)
  if (!device) return
  activateTab('files')
  clearTransferPaths()
  await addTransferPaths()
  if (transferPathsStore.get().length) await sendWithLocalSend(device)
}

/** Keeps the tray menu in step with the paired computers and carries out what's picked there. */
export function TrayBackground() {
  const paired = useStore(bridgeLinkStore).paired
  const config = useStore(configStore)
  const peers = trayPeers(paired, config.devices)
  const key = JSON.stringify([peers, config.clipboard.sync])
  useEffect(() => {
    if (isTauri()) void trayUpdate(peers, config.clipboard.sync).catch(() => undefined)
  }, [key])

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let closed = false
    void listen<TrayAction>('tray-action', event => void run(event.payload)).then(fn => { if (closed) fn(); else unlisten = fn })
    return () => { closed = true; unlisten?.() }
  }, [])
  return null
}
