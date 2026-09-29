import { connectRustDesk, rustDeskEnsureRunning, rustDeskIdentity } from '../../lib/bridge'
import { advertise } from '../../core/bridgelink'
import { configStore, serviceConfig } from '../../core/config'
import { setNotice } from '../../core/notice'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import type { MachineConfig, RustDeskIdentity } from '../../types'

export const rustdeskInfoStore = createStore<RustDeskIdentity>({ available: false })

export const rustdeskExecutable = () => serviceConfig(configStore.get(), 'rustdesk')?.executable

export async function refreshRustDeskIdentity() {
  try {
    const identity = await rustDeskIdentity(rustdeskExecutable())
    rustdeskInfoStore.set(identity)
    if (identity.id) advertise({ rustdeskId: identity.id })
  } catch {
    rustdeskInfoStore.set({ available: false })
  }
}

export async function startRustDeskSession(machine: MachineConfig, mode: 'control' | 'file-transfer') {
  if (!machine.rustdeskPeerId) return
  try {
    setNotice(`${mode === 'control' ? 'Connecting to' : 'Opening file transfer with'} ${machine.name}…`)
    let host = ''
    try { host = new URL(machine.agentUrl).hostname } catch { /* manual config */ }
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') host = ''
    const route = await connectRustDesk(machine.rustdeskPeerId, rustdeskExecutable(), mode, host)
    setNotice(`RustDesk ${mode === 'control' ? 'control session' : 'file-transfer session'} launched for ${machine.name}${route ? ` via ${route}` : ''}.`)
  } catch (error) {
    // Native command errors arrive as plain strings.
    setNotice(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not start RustDesk session')
  }
}

export function RemoteBackground() {
  const services = useStore(configStore).services
  usePeriodicRefresh(async () => {
    // RustDesk runs whenever BridgeDeck does, so the paired computer can always connect.
    if (serviceConfig(configStore.get(), 'rustdesk')?.enabled) {
      try {
        const ensured = await rustDeskEnsureRunning(rustdeskExecutable())
        if (ensured.started) setNotice('Started RustDesk in the background so this computer can be controlled.')
      } catch { /* browser mode */ }
    }
    await refreshRustDeskIdentity()
  }, 15000, [services])
  return null
}
