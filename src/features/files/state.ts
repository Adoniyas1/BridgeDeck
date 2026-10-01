import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { listen } from '@tauri-apps/api/event'
import {
  localSendAccept, localSendDecline, localSendNativeSend, localSendReceiverStart, localSendReceiverStatus,
  localSendReceiverStop, localSendSetTrustedHosts, pickTransferPaths, sendFilesPending, sendToIntegration,
} from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { configStore, serviceConfig } from '../../core/config'
import { freshTransfers, notify } from '../../core/notify'
import { fmtSize } from '../../core/util'
import { createStore, useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import type { DeviceConfig, LocalSendReceiverStatus } from '../../types'

export const receiverStore = createStore<LocalSendReceiverStatus>({ running: false, alias: 'BridgeDeck', port: 53317, destination: '', recent: [], devices: [] })
export const transferPathsStore = createStore<string[]>([])
export const transferStateStore = createStore('Choose files or a folder, then select a destination.')
export const transferBusyStore = createStore(false)

const setTransferState = transferStateStore.set
const addPaths = (paths: string[]) => transferPathsStore.set(current => Array.from(new Set([...current, ...paths])))
export const clearTransferPaths = () => transferPathsStore.set([])

/** Integration with the file manager's Send to / Open With (see `send_to.rs`). */
export const sendToStore = createStore<{ kind: 'send-to' | 'open-with' | ''; installed: boolean; error?: string }>({ kind: '', installed: false })

/** Files handed over from the file manager wait here for a computer to be picked. */
async function takeSentFiles() {
  const paths = await sendFilesPending().catch(() => [] as string[])
  if (!paths.length) return
  addPaths(paths)
  setTransferState(`${paths.length} item${paths.length === 1 ? '' : 's'} ready to send. Pick a computer.`)
  activateTab('files')
}

export async function addTransferPaths(directory = false) {
  try {
    const picked = await pickTransferPaths(directory)
    if (!picked.length) return
    addPaths(picked)
    setTransferState(`${picked.length} ${directory ? 'folder' : 'file'} selection${picked.length === 1 ? '' : 's'} added.`)
  } catch (error) {
    setTransferState(error instanceof Error ? error.message : 'Could not open file picker')
  }
}

export async function sendWithLocalSend(machine: DeviceConfig) {
  const paths = transferPathsStore.get()
  if (!machine.localsendTarget || !paths.length || transferBusyStore.get()) return
  transferBusyStore.set(true)
  setTransferState(`Sending ${paths.length} selection${paths.length === 1 ? '' : 's'} to ${machine.name}…`)
  try {
    const result = await localSendNativeSend(machine.localsendTarget, paths, machine.localsendPin)
    const detail = result.stdout || result.stderr
    if (!result.ok) throw new Error(detail || 'LocalSend transfer failed')
    setTransferState(`Transfer to ${machine.name} completed.${detail ? ` ${detail}` : ''}`)
  } catch (error) {
    setTransferState(error instanceof Error ? error.message : 'LocalSend transfer failed')
  } finally {
    transferBusyStore.set(false)
  }
}

export async function startLocalSendReceiver() {
  try {
    setTransferState('Starting LocalSend receiver…')
    const status = await localSendReceiverStart(configStore.get().localsend)
    receiverStore.set(status)
    setTransferState(status.detail || 'LocalSend receiver started.')
  } catch (error) {
    setTransferState(error instanceof Error ? error.message : 'Could not start LocalSend receiver')
  }
}

export async function stopLocalSendReceiver() {
  try {
    receiverStore.set(await localSendReceiverStop())
    setTransferState('LocalSend receiver stopped.')
  } catch (error) {
    setTransferState(error instanceof Error ? error.message : 'Could not stop LocalSend receiver')
  }
}

export async function answerLocalSend(accept: boolean) {
  const sessionId = receiverStore.get().pending?.sessionId
  if (!sessionId) return
  try {
    receiverStore.set(accept ? await localSendAccept(sessionId) : await localSendDecline(sessionId))
    setTransferState(accept ? 'Incoming transfer accepted.' : 'Incoming transfer declined.')
  } catch (error) {
    setTransferState(error instanceof Error ? error.message : 'Could not answer incoming transfer')
  }
}

const openedAt = Date.now()
const announced = new Set<string>()

export function FilesBackground() {
  const running = useStore(receiverStore).running
  // Every address a paired computer has used (Wi-Fi, Ethernet, Tailscale), not just the current one:
  // a transfer from any of them is accepted without a prompt nobody might see.
  const pairedHosts = [...new Set(useStore(bridgeLinkStore).paired.flatMap(peer => [peer.host, ...(peer.addresses ?? [])]))].sort().join(',')

  // Receiving always starts with the app so the paired computer can send without setup.
  useEffect(() => {
    if (!serviceConfig(configStore.get(), 'localsend')?.enabled) return
    void localSendReceiverStart(configStore.get().localsend).then(receiverStore.set).catch(() => undefined)
  }, [])

  useEffect(() => {
    const poll = async () => {
      try { receiverStore.set(await localSendReceiverStatus()) } catch { /* browser mode */ }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1200)
    return () => window.clearInterval(timer)
  }, [])

  // Finished transfers, and requests that wait for Accept, as desktop notifications.
  useEffect(() => receiverStore.subscribe(() => {
    const { recent, pending } = receiverStore.get()
    for (const item of freshTransfers(recent, announced, openedAt)) {
      if (item.status === 'received') notify('files', `Files from ${item.senderAlias}`, `${item.files} file${item.files === 1 ? '' : 's'} · ${fmtSize(item.bytes)} saved${item.destination ? ` to ${item.destination}` : ''}`)
      else if (item.status === 'message' && item.message) notify('files', `Message from ${item.senderAlias}`, item.message)
    }
    if (pending && !announced.has(pending.sessionId)) {
      announced.add(pending.sessionId)
      notify('files', `${pending.senderAlias} wants to send you files`, `${pending.files.length} file${pending.files.length === 1 ? '' : 's'} · ${fmtSize(pending.totalBytes)}. Open BridgeDeck’s Files tab to accept.`)
    }
  }), [])

  // Files from paired computers are accepted without a prompt; everyone else still needs approval.
  useEffect(() => {
    void localSendSetTrustedHosts(pairedHosts ? pairedHosts.split(',') : []).catch(() => undefined)
  }, [pairedHosts, running])

  // Explorer's Send to / Finder's Open With hand files over; some may have arrived before the UI loaded.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let unlisten: (() => void) | undefined
    let closed = false
    void takeSentFiles()
    void listen('send-files', () => void takeSentFiles()).then(fn => { if (closed) fn(); else unlisten = fn })
    return () => { closed = true; unlisten?.() }
  }, [])

  const sendToEnabled = useStore(configStore).sendTo.enabled
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    void sendToIntegration(sendToEnabled).then(sendToStore.set).catch(error => sendToStore.set(current => ({ ...current, error: String(error) })))
  }, [sendToEnabled])

  // Dropping files anywhere on the window queues them for sending.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let unlisten: (() => void) | undefined
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type !== 'drop' || !event.payload.paths.length) return
      const dropped = event.payload.paths
      addPaths(dropped)
      setTransferState(`${dropped.length} item${dropped.length === 1 ? '' : 's'} dropped. Pick a computer to send to.`)
      activateTab('files')
    }).then(fn => { unlisten = fn })
    return () => unlisten?.()
  }, [])

  return null
}
