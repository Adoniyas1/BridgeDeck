import { useEffect } from 'react'
import { blueBubblesEnsureRunning, blueBubblesLocalPort } from '../../lib/bridge'
import { bridgeLinkStore } from '../../core/bridgelink'
import { configStore, serviceConfig, setConfig } from '../../core/config'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { isStaleLanUrl } from '../../core/util'

export const messagesUnreadStore = createStore(0)

const setBlueBubblesUrl = (url: string) => setConfig(c => c.bluebubbles.baseUrl === url ? c : { ...c, bluebubbles: { ...c.bluebubbles, baseUrl: url } })

export function MessagesBackground() {
  const services = useStore(configStore).services
  const paired = useStore(bridgeLinkStore).paired

  usePeriodicRefresh(async () => {
    // On the Mac, keep BlueBubbles Server up for the Windows Messages page (no-op on Windows).
    if (serviceConfig(configStore.get(), 'bluebubbles')?.enabled) {
      try { await blueBubblesEnsureRunning() } catch { /* browser mode */ }
    }
    // The computer that hosts BlueBubbles talks to it over loopback, never a LAN IP that DHCP can change.
    try {
      const localPort = await blueBubblesLocalPort()
      if (!localPort) return
      const local = `http://127.0.0.1:${localPort}`
      const saved = configStore.get().bluebubbles.baseUrl
      if (!saved || (saved !== local && isStaleLanUrl(saved, local))) setBlueBubblesUrl(local)
    } catch { /* browser mode */ }
  }, 15000, [services])

  // The Mac advertises BlueBubbles Server's URL (never its password). Fill it in when unset, and follow
  // the Mac to a new DHCP address when the saved URL is a LAN IP on the same port.
  const advertisedUrls = paired.map(peer => peer.bluebubblesUrl || '').join(',')
  useEffect(() => {
    for (const url of advertisedUrls.split(',').filter(Boolean)) {
      const saved = configStore.get().bluebubbles.baseUrl
      if (saved !== url && (!saved || isStaleLanUrl(saved, url))) setBlueBubblesUrl(url)
    }
  }, [advertisedUrls])

  return null
}
