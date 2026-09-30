import { isTauri, legacyApps, legacyAppsStop, type LegacyApp } from '../../lib/bridge'
import { setNotice } from '../../core/notice'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore } from '../../core/store'

/** Apps older BridgeDeck versions needed (RustDesk, BlueBubbles) that are still on this computer. */
export const leftoverStore = createStore<{ apps: LegacyApp[]; busy: boolean }>({ apps: [], busy: false })

async function refresh() {
  if (!isTauri() || leftoverStore.get().busy) return
  const apps = await legacyApps().catch(() => [])
  leftoverStore.set(current => ({ ...current, apps }))
}

export async function stopLeftovers() {
  leftoverStore.set(current => ({ ...current, busy: true }))
  try {
    const apps = await legacyAppsStop()
    leftoverStore.set({ apps, busy: false })
    const back = apps.filter(a => a.running)
    setNotice(back.length
      ? `${back.map(a => a.name).join(' and ')} started again: its system service restarts it. Uninstall it to remove it for good.`
      : 'Stopped. They won’t open at login any more; uninstall them whenever you like.')
  } catch (error) {
    leftoverStore.set(current => ({ ...current, busy: false }))
    setNotice(error instanceof Error ? error.message : String(error))
  }
}

export function LeftoverBackground() {
  usePeriodicRefresh(refresh, 5 * 60_000, [])
  return null
}
