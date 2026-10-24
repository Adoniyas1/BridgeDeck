import { lazy, Suspense, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
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
import { allDue, deckOf, isNewReview } from '../study/cards'
import { showAnswer } from '../study/answer'
import { libraryStore, saveReview } from '../study/state'
import { courseOfFolder } from '../../core/exam'
// The QR code library loads when the code is first shown, not with the app.
const QrCode = lazy(() => import('./QrCode'))
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
  // Flashcards due, mixed across courses, to review on the phone (even offline).
  const courses = libraryStore.get().library?.courses.filter(c => !c.archived).map(c => c.name) ?? []
  const plain = (t: string) => t.replace(/\s*\(\[[^\]]*\]\(book:[^)]*\)\)\s*$/, '').replace(/!\[[^\]]*\]\(bdimg:[^)]*\)/g, '[picture]').trim()
  const cards = allDue(notesStore.get(), courses, now, 15).slice(0, 80).map(c => ({ id: c.id, course: courseOfFolder(notesStore.get().find(n => n.id === c.noteId)?.folder) ?? '', front: plain(c.front), back: plain(showAnswer(c.back)) }))
  return { at: now, today: items, due, cards }
}

async function applyPhoneReviews(reviews: Array<{ card: string; grade: number; at: number }>) {
  const { review } = await import('../study/review')
  const courses = libraryStore.get().library?.courses.map(c => c.name) ?? []
  let applied = 0
  for (const r of [...reviews].sort((a, b) => a.at - b.at)) {
    if (![1, 2, 3, 4].includes(r.grade)) continue
    const card = courses.flatMap(c => deckOf(notesStore.get(), c)).find(c => c.id === r.card)
    if (!card || !isNewReview(card.card, r.at)) continue
    try { await saveReview(card, review(card.card, r.grade as 1 | 2 | 3 | 4, new Date(r.at)), r.grade); applied++ } catch { /* the next sync tries again from the phone's copy */ }
  }
  if (applied) setNotice(`Saved ${applied} flashcard review${applied === 1 ? '' : 's'} from your phone.`)
}

/** Starts or stops the page with the setting, keeps its agenda current, and tells you what arrived. */
export function PhoneBackground() {
  const { enabled, tailscale, https } = useStore(configStore).phone
  useEffect(() => {
    if (isTauri()) void phoneSettings(enabled, tailscale === true, https === true).then(phoneStore.set).catch(() => undefined)
  }, [enabled, tailscale, https])
  usePeriodicRefresh(async () => { if (isTauri() && enabled) await phonePublish(phoneSnapshot()) }, 60_000, [enabled], 'same')
  useEffect(() => {
    if (!isTauri()) return
    const offs: Array<() => void> = []
    let closed = false
    const add = (p: Promise<() => void>) => void p.then(fn => { if (closed) fn(); else offs.push(fn) })
    // Flashcards reviewed on the phone (possibly offline, sent later), applied here in order.
    add(listen<{ reviews: Array<{ card: string; grade: number; at: number }> }>('phone-reviews', e => void applyPhoneReviews(e.payload.reviews)))
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

export function PhoneCard() {
  const config = useConfig()
  const status = useStore(phoneStore)
  const [busy, setBusy] = useState(false)
  const on = config.phone.enabled
  usePeriodicRefresh(async () => { if (isTauri() && on) phoneStore.set(await phoneStatus()) }, 15_000, [on])
  const url = status.urls[0]
  return <Card><SectionTitle title="Phone" subtitle="Send text, links and photos from your phone, see today and what’s due, tick checklists. No app needed." action={<StatusPill online={on && status.running} label={on ? (status.running ? 'On' : 'Starting') : 'Off'} />} />
    <Toggle checked={on} onChange={next => setConfig(c => ({ ...c, phone: { ...c.phone, enabled: next } }))} label="Let my phone open BridgeDeck’s page on this Wi-Fi" />
    {on && <Toggle checked={config.phone.tailscale === true} onChange={next => setConfig(c => ({ ...c, phone: { ...c.phone, tailscale: next } }))} label="Also over Tailscale (on campus): needs Tailscale on this computer and the phone. The page is plain HTTP inside Tailscale’s encrypted network; anyone on your tailnet with the link can open it." />}
    {on && config.phone.tailscale && <Toggle checked={config.phone.https === true} onChange={next => setConfig(c => ({ ...c, phone: { ...c.phone, https: next } }))} label="Use HTTPS over Tailscale (the phone's camera and offline use need it): turn on MagicDNS and HTTPS Certificates in the Tailscale admin page first. The address becomes this computer's name in your tailnet." />}
    {on && status.error && <p className="error-text">{status.error}</p>}
    {on && url && <div className="phone-link">
      <Suspense fallback={<div className="phone-qr" />}><QrCode text={url} /></Suspense>
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
