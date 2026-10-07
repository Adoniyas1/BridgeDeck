import { CalendarDays, ListChecks } from 'lucide-react'
import { useMemo } from 'react'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle } from '../../ui'
import { addDays, colorOf, formatRange, startOfDay } from './model'
import { useItems } from './state'

/** Today's events, Apple Calendar items and due checklist items, for Home. */
export default function TodayAgenda() {
  const [today, end] = useMemo(() => { const t = startOfDay(Date.now()); return [t, addDays(t, 2)] }, [])
  const items = useItems(today, end)
  const now = Date.now()
  const todays = items.filter(i => i.start < addDays(today, 1) && (i.allDay || i.end > now || i.start >= now || i.source === 'todo'))
  const tomorrow = items.filter(i => i.start >= addDays(today, 1)).slice(0, 3)
  const row = (item: typeof items[number]) => <button key={item.key} className="agenda-row" onClick={() => activateTab(item.source === 'todo' ? 'notes' : item.source === 'canvas' ? 'study' : 'calendar')}>
    <i style={{ background: colorOf(item.color) }} />
    <span className="agenda-time">{item.source === 'todo' ? <ListChecks size={12} /> : null}{formatRange(item)}</span>
    <span className="grow agenda-title">{item.title}</span>
  </button>
  return <Card className="agenda-card"><SectionTitle title="Today" subtitle={new Date(today).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
    action={<button className="ghost" onClick={() => activateTab('calendar')}><CalendarDays size={14} /> Calendar</button>} />
    {todays.length ? <div className="agenda-list">{todays.map(row)}</div> : <p className="agenda-empty">Nothing else today.</p>}
    {tomorrow.length > 0 && <><h4 className="agenda-sub">Tomorrow</h4><div className="agenda-list">{tomorrow.map(row)}</div></>}
  </Card>
}
