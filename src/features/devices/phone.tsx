import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import qrcode from 'qrcode-generator'
import { Copy, RefreshCw, Smartphone } from 'lucide-react'
import { isTauri, phoneNewKey, phonePublish, phoneSettings, phoneStatus, type PhoneStatus } from '../../lib/bridge'
import { configStore, setConfig, useConfig } from '../../core/config'
import { setNotice } from '../../core/notice'
import { notify } from '../../core/notify'
import { usePeriodicRefresh } from '../../core/refresh'
import { createStore, useStore } from '../../core/store'
import { Card, SectionTitle, StatusPill, Toggle } from '../../ui'
import { appleStore, eventsStore, itemsBetween } from '../calendar/state'
import { addDays, startOfDay } from '../calendar/model'
import { notesStore } from '../notes/state'
import { allAssignments } from '../study/assignments'
import { dueText, groupAssignments } from '../study/canvas'

export const phoneStore = createStore<PhoneStatus>({ running: false, urls: [], error: '' })

/** What the phone page shows for today and the week: worked out here, where recurring events and
 *  Canvas are known. */
export function phoneSnapshot(now = Date.now()) {
  const today = startOfDay(now)
  const showApple = configStore.get().calendar.showApple
  const items = itemsBetween(eventsStore.get(), notesStore.get(), showApple ? appleStore.get().items : [], today, addDays(today, 1))
    .filter(i => i.source !== 'todo' && (i.allDay || i.end >= now || i.start >= now))
    .slice(0, 20)
    .map(i => ({ title: i.title, start: i.start, end: i.end, allDay: i.allDay }))
  const groups = groupAssignments(allAssignments(), now)
  const due = [...groups.overdue, ...groups.today, ...groups.week].slice(0, 20).map(a => ({ title: a.title, course: a.course, when: dueText(a.due, now), late: a.due != null && a.due < now }))
  return { at: now, today: items, due }
}

/** Starts or stops the page with the setting, keeps its agenda current, and tells you what arrived. */
export function PhoneBackground() {
  const enabled = useStore(configStore).phone.enabled
  useEffect(() => {
    if (isTauri()) void phoneSettings(enabled).then(phoneStore.set).catch(() => undefined)
  }, [enabled])
  usePeriodicRefresh(async () => { if (isTauri() && enabled) await phonePublish(phoneSnapshot()) }, 60_000, [enabled])
  useEffect(() => {
    if (!isTauri()) return
    const offs: Array<() => void> = []
    let closed = false
    const add = (p: Promise<() => void>) => void p.then(fn => { if (closed) fn(); else offs.push(fn) })
    add(listen<{ text: string }>('phone-text', e => {
      const short = e.payload.text.length > 80 ? `${e.payload.text.slice(0, 80)}…` : e.payload.text
      setNotice(`From your phone, on the clipboard: “${short}”`)
      notify('files', 'From your phone', short)
    }))
    add(listen<{ name: string }>('phone-file', e => {
      setNotice(`From your phone: ${e.payload.name}, in the “From phone” folder.`)
      notify('files', 'File from your phone', e.payload.name)
    }))
    return () => { closed = true; offs.forEach(fn => fn()) }
  }, [])
  return null
}

/** A QR code drawn as squares (no markup from outside). */
function QrCode({ text }: { text: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`
    return { n, d }
  }, [text])
  return <svg className="phone-qr" viewBox={`-2 -2 ${cells.n + 4} ${cells.n + 4}`} role="img" aria-label="QR code for the phone page"><rect x={-2} y={-2} width={cells.n + 4} height={cells.n + 4} fill="#fff" /><path d={cells.d} fill="#000" /></svg>
}

export function PhoneCard() {
  const config = useConfig()
  const status = useStore(phoneStore)
  const [busy, setBusy] = useState(false)
  const on = config.phone.enabled
  usePeriodicRefresh(async () => { if (isTauri() && on) phoneStore.set(await phoneStatus()) }, 15_000, [on])
  const url = status.urls[0]
  return <Card><SectionTitle title="Phone" subtitle="Send text, links and photos from your phone, see today and what’s due, tick checklists. No app needed." action={<StatusPill online={on && status.running} label={on ? (status.running ? 'On' : 'Starting') : 'Off'} />} />
    <Toggle checked={on} onChange={next => setConfig(c => ({ ...c, phone: { enabled: next } }))} label="Let my phone open BridgeDeck’s page on this Wi-Fi" />
    {on && status.error && <p className="error-text">{status.error}</p>}
    {on && url && <div className="phone-link">
      <QrCode text={url} />
      <div className="grow">
        <p>Scan this with your phone’s camera (on the same Wi-Fi), then add the page to your home screen.</p>
        <code className="phone-url">{url.replace(/#.*/, '#…')}</code>
        <div className="actions">
          <button className="secondary" onClick={() => void navigator.clipboard.writeText(url).then(() => setNotice('Phone link copied.'))}><Copy size={14} />Copy link</button>
          <button className="secondary" disabled={busy} title="Phones with the old link stop working" onClick={() => { setBusy(true); void phoneNewKey().then(phoneStore.set).finally(() => setBusy(false)) }}><RefreshCw size={14} />New link</button>
        </div>
      </div>
    </div>}
    {on && status.running && !url && <p className="hint">This computer isn’t on a network right now.</p>}
    <div className="remote-note"><Smartphone size={22} /><p>The page works on the same Wi-Fi only, and only with the key in the link. The first time, {navigator.userAgent.includes('Mac') ? 'macOS' : 'Windows'} may ask to allow incoming connections: allow it on private networks. Files go to the “From phone” folder in the shared folder.</p></div>
  </Card>
}
