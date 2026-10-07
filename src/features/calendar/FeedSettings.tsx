import { useState } from 'react'
import { CalendarPlus, Trash2 } from 'lucide-react'
import { setConfig, useConfig } from '../../core/config'
import { useStore } from '../../core/store'
import { Card, SectionTitle } from '../../ui'
import { feedErrorsStore, feedItemsStore, refreshFeeds } from './feeds'
import { COLORS, colorOf } from './model'

/** Settings → Calendar: calendars subscribed to by link (Outlook, Google, a school's calendar). */
export function CalendarFeeds() {
  const config = useConfig()
  const feeds = config.calendar.feeds
  const errors = useStore(feedErrorsStore)
  const items = useStore(feedItemsStore)
  const [name, setName] = useState('Outlook')
  const [url, setUrl] = useState('')
  const valid = /^(https|webcal):\/\/[^/\s]+\.[^/\s]+\//.test(url.trim())
  const setFeeds = (next: typeof feeds) => { setConfig(c => ({ ...c, calendar: { ...c.calendar, feeds: next } })); window.setTimeout(() => void refreshFeeds(), 100) }
  function add() {
    if (!valid) return
    const used = new Set(feeds.map(f => f.color))
    const color = COLORS.map(([n]) => n).find(n => !used.has(n) && n !== 'teal') ?? 'purple'
    setFeeds([...feeds, { id: Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'x'), name: name.trim() || 'Calendar', url: url.trim(), color }])
    setUrl('')
  }
  return <Card><SectionTitle title="Subscribed calendars" subtitle="Outlook, Google or a school calendar, shown in the Calendar (read-only)" action={<CalendarPlus size={18} />} />
    {feeds.map(f => <div key={f.id} className="feed-row">
      <i style={{ background: colorOf(f.color) }} />
      <span className="grow"><strong>{f.name}</strong><small>{errors[f.id] ? errors[f.id] : `${items.filter(i => i.key.startsWith(`feed:${f.id}:`)).length} events`}</small></span>
      <button className="cal-icon" title={`Remove ${f.name}`} onClick={() => setFeeds(feeds.filter(x => x.id !== f.id))}><Trash2 size={14} /></button>
    </div>)}
    <form className="feed-add" onSubmit={e => { e.preventDefault(); add() }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
      <input type="password" autoComplete="off" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" />
      <button className="secondary" disabled={!valid}>Add</button>
    </form>
    <p className="hint"><strong>Outlook:</strong> on outlook.office.com, Settings (gear) → Calendar → Shared calendars → “Publish a calendar”: pick your calendar and “Can view all details”, Publish, then copy the <strong>ICS</strong> link here. <strong>Google:</strong> calendar settings → “Secret address in iCal format”. Checked every 30 minutes; the link stays on this computer.</p>
  </Card>
}
