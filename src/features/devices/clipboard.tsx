import { useEffect, useState } from 'react'
import { ClipboardCopy, History, Search, Trash2 } from 'lucide-react'
import { clipboardHistory, clipboardHistoryClear, clipboardHistorySettings, clipboardPut, clipboardSettings, clipboardStatus, isTauri, type ClipboardEntry, type ClipboardStatus } from '../../lib/bridge'
import { setNotice } from '../../core/notice'
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
  const { sync, history } = useStore(configStore).clipboard
  useEffect(() => {
    if (isTauri()) void clipboardSettings(sync).then(clipboardStore.set).catch(() => undefined)
  }, [sync])
  useEffect(() => {
    if (isTauri()) void clipboardHistorySettings(history).catch(() => undefined)
  }, [history])
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

const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : time(ms)
}

/** Text copied recently, here or on a paired computer: click one to put it back on the clipboard. */
export function ClipboardHistoryCard() {
  const config = useConfig()
  const on = config.clipboard.history
  const [entries, setEntries] = useState<ClipboardEntry[]>([])
  const [query, setQuery] = useState('')
  usePeriodicRefresh(async () => { if (isTauri() && on) setEntries(await clipboardHistory()) }, 2000, [on])
  const shown = entries.filter(e => !query.trim() || e.text.toLowerCase().includes(query.trim().toLowerCase()))
  async function put(entry: ClipboardEntry) {
    try { await clipboardPut(entry.text); setNotice('Copied. Paste it anywhere.') } catch (e) { setNotice(String(e)) }
  }
  return <Card><SectionTitle title="Clipboard history" subtitle={on ? `${entries.length} recent cop${entries.length === 1 ? 'y' : 'ies'} · click one to copy it again` : 'Off'} action={<History size={18} />} />
    <Toggle checked={on} onChange={next => setConfig(c => ({ ...c, clipboard: { ...c.clipboard, history: next } }))} label="Keep the last 50 things I copy (text), until BridgeDeck quits" />
    {on && entries.length > 0 && <>
      <div className="clip-tools">
        <label className="clip-search"><Search size={13} /><input placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <button className="ghost" onClick={() => void clipboardHistoryClear().then(() => setEntries([]))}><Trash2 size={13} /> Clear</button>
      </div>
      <div className="clip-list">{shown.map(e => <button key={`${e.at}-${e.text.slice(0, 20)}`} onClick={() => void put(e)} title="Copy this again">
        <span className="clip-text">{e.text.length > 300 ? `${e.text.slice(0, 300)}…` : e.text}</span>
        <small>{e.from} · {ago(e.at)}</small>
      </button>)}</div>
    </>}
    {on && !entries.length && <p className="hint">Copy something and it shows here. Passwords from a password manager are never kept, and the list is gone when BridgeDeck quits.</p>}
  </Card>
}
