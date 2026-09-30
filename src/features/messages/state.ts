import { useEffect } from 'react'
import { imessage } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { errorText } from '../../core/util'

export const messagesUnreadStore = createStore(0)

/** Where Messages come from: this Mac (`peer: null`) or a paired Mac. */
export type MessagesSource = { peer: string | null; ready: boolean; name: string; detail: string }
export const messagesSourceStore = createStore<MessagesSource>({ peer: null, ready: false, name: '', detail: 'Looking for your Mac…' })

type EngineStatus = { available: boolean; detail?: string | null }

/** On a Mac, BridgeDeck reads Messages itself; elsewhere it asks the first paired Mac. */
export async function findMessagesSource(): Promise<MessagesSource> {
  const link = bridgeLinkStore.get()
  if (link.platform === 'macos') {
    const status = await imessage<EngineStatus>(null, { op: 'status' })
    return { peer: null, ready: status.available, name: 'this Mac', detail: status.detail ?? '' }
  }
  const mac = link.paired.find(p => p.platform === 'macos')
  if (!mac) return { peer: null, ready: false, name: '', detail: 'Pair your Mac on the Devices tab: it reads your Messages and sends them from here.' }
  try {
    const status = await imessage<EngineStatus>(mac.instanceId, { op: 'status' })
    return { peer: mac.instanceId, ready: status.available, name: mac.name, detail: status.available ? '' : `${mac.name}: ${status.detail || 'Messages are not readable yet'}` }
  } catch (error) {
    return { peer: mac.instanceId, ready: false, name: mac.name, detail: errorText(error, `Can't reach ${mac.name}`) }
  }
}

async function refreshSource() {
  try {
    const next = await findMessagesSource()
    const current = messagesSourceStore.get()
    // Keep a working source through one failed check (the Mac waking up, a network blip).
    if (current.ready && !next.ready && current.peer === next.peer && !sourceMisses++) return
    sourceMisses = 0
    if (JSON.stringify(current) !== JSON.stringify(next)) messagesSourceStore.set(next)
  } catch (error) {
    messagesSourceStore.set({ peer: null, ready: false, name: '', detail: errorText(error, 'Messages need the BridgeDeck app') })
  }
}
let sourceMisses = 0

export function MessagesBackground() {
  const link = useStore(bridgeLinkStore)
  const macs = link.paired.filter(p => p.platform === 'macos').map(p => p.instanceId).join(',')
  usePeriodicRefresh(refreshSource, 30000, [link.platform, macs])
  useEffect(() => { void refreshSource() }, [link.running])
  return null
}
