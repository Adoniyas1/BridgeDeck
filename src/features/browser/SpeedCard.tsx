import { useEffect, useState } from 'react'
import { Gauge, Moon } from 'lucide-react'
import { browserPagesStatus, browserSleepNow, isTauri, type PagesStatus } from '../../lib/bridge'
import { setConfig, useConfig } from '../../core/config'
import { Card, SectionTitle } from '../../ui'

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

/** Settings → Browser: how much memory is free, how many web pages are open, and how soon hidden
 *  ones go to sleep (each page is a process of its own; on an 8 GB computer they add up). */
export function SpeedCard() {
  const config = useConfig()
  const [status, setStatus] = useState<PagesStatus | null>(null)
  const [message, setMessage] = useState('')
  const load = () => { if (isTauri()) void browserPagesStatus().then(setStatus).catch(() => undefined) }
  useEffect(() => { load(); const t = window.setInterval(load, 5000); return () => window.clearInterval(t) }, [])
  const used = status ? 1 - status.memoryAvailable / status.memoryTotal : 0
  return <Card><SectionTitle title="Speed and memory" subtitle="Web pages (ChatGPT, Spotify, TV, Mail, Browser tabs) each use memory of their own" action={<Gauge size={18} />} />
    {status && <>
      <div className="speed-meter"><i className={used > 0.85 ? 'bad' : used > 0.7 ? 'warn' : ''} style={{ width: `${used * 100}%` }} /></div>
      <p className="hint">{gb(status.memoryAvailable)} free of {gb(status.memoryTotal)} · {status.open} web page{status.open === 1 ? '' : 's'} open ({status.hidden} hidden){status.asleep ? ` · ${status.asleep} asleep` : ''}{used > 0.85 ? '. Memory is tight: put hidden pages to sleep, or close tabs you aren’t using.' : ''}</p>
    </>}
    <label className="cal-setting">Put hidden pages to sleep after
      <select value={config.browsing.sleepMinutes} onChange={e => setConfig(c => ({ ...c, browsing: { ...c.browsing, sleepMinutes: Number(e.target.value) } }))}>
        <option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={0}>Never</option>
      </select>
    </label>
    <div className="actions"><button className="secondary" disabled={!isTauri()} onClick={() => void browserSleepNow().then(n => { setMessage(n ? `${n} page${n === 1 ? '' : 's'} put to sleep.` : 'No hidden pages to put to sleep.'); load() })}><Moon size={14} />Put hidden pages to sleep now</button></div>
    {message && <p className="hint">{message}</p>}
    <p className="hint">A sleeping page opens again where it was when you go back to it (you stay signed in). Spotify and TV stay awake so music and video keep playing, and so do mail accounts while “Check for new mail in the background” is on.</p>
  </Card>
}
