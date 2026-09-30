import { useEffect } from 'react'
import { ClipboardCopy } from 'lucide-react'
import { clipboardSettings, clipboardStatus, isTauri, type ClipboardStatus } from '../../lib/bridge'
import { configStore, setConfig, useConfig } from '../../core/config'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { Card, SectionTitle, StatusPill, Toggle } from '../../ui'

export const clipboardStore = createStore<ClipboardStatus>({ enabled: false, available: false, last: null, errors: [] })

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** One line about the last copy that crossed over, for Home and the Computers tab. */
export function clipboardDetail(status: ClipboardStatus, sync: boolean) {
  if (!sync) return 'Off'
  if (isTauri() && !status.available) return 'This computer’s clipboard can’t be opened'
  const last = status.last
  if (!last) return 'Copy on one computer, paste on the others'
  const what = last.kind === 'image' ? 'a picture' : `“${last.summary}”`
  return last.direction === 'sent' ? `Sent ${what} to ${last.peers.join(', ')} at ${time(last.at)}` : `Got ${what} from ${last.peers[0]} at ${time(last.at)}`
}

/** Hands the setting to the native side (which sends nothing until it arrives) and follows its status. */
export function ClipboardBackground() {
  const sync = useStore(configStore).clipboard.sync
  useEffect(() => {
    if (isTauri()) void clipboardSettings(sync).then(clipboardStore.set).catch(() => undefined)
  }, [sync])
  usePeriodicRefresh(async () => { if (isTauri()) clipboardStore.set(await clipboardStatus()) }, 3000, [])
  return null
}

export function ClipboardCard() {
  const config = useConfig()
  const status = useStore(clipboardStore)
  const sync = config.clipboard.sync
  return <Card><SectionTitle title="Clipboard" subtitle={clipboardDetail(status, sync)} action={<StatusPill online={sync && (status.available || !isTauri())} label={sync ? 'Shared' : 'Off'}/>} />
    <Toggle checked={sync} onChange={next => setConfig(c => ({ ...c, clipboard: { ...c.clipboard, sync: next } }))} label="Share the clipboard with my paired computers" />
    {sync && !!status.errors.length && <p className="error-text">Didn’t reach {status.errors.join('; ')}</p>}
    <div className="remote-note"><ClipboardCopy size={22}/><p>Text and pictures you copy go straight to your other computers over the encrypted link. Passwords copied from a password manager stay on this computer. Turn this off on a computer to stop it sending and receiving.</p></div>
  </Card>
}
