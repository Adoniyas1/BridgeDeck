import { CalendarDays } from 'lucide-react'
import { useEffect, useState } from 'react'
import { calendarAppleShare, isTauri } from '../../lib/bridge'
import { setConfig, useConfig } from '../../core/config'
import { Card, SectionTitle, Toggle } from '../../ui'
import type { FeatureManifest } from '../features'
import CalendarPage from './CalendarPage'
import { appleStore, CalendarBackground } from './state'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

function CalendarSettings() {
  const config = useConfig()
  const [sharing, setSharing] = useState(false)
  useEffect(() => { if (isTauri() && isMac) void calendarAppleShare().then(setSharing).catch(() => undefined) }, [])
  const setCalendar = (changes: Partial<typeof config.calendar>) => setConfig(c => ({ ...c, calendar: { ...c.calendar, ...changes } }))
  return <Card><SectionTitle title="Calendar" subtitle="Events are kept on every paired computer" />
    {isMac
      ? <Toggle checked={sharing && config.calendar.showApple} label="Show Apple Calendar and Reminders (read-only), here and on my paired computer" onChange={on => {
          setCalendar({ showApple: on })
          appleStore.set(s => ({ ...s, at: 0, items: on ? s.items : [], errors: [] }))
          void calendarAppleShare(on).then(setSharing).catch(() => undefined)
        }} />
      : <Toggle checked={config.calendar.showApple} label="Show Apple Calendar and Reminders from my Mac (read-only; turn it on there too)" onChange={on => { setCalendar({ showApple: on }); appleStore.set(s => ({ ...s, at: 0, items: on ? s.items : [], errors: [] })) }} />}
    <label className="cal-setting">Week starts on
      <select value={config.calendar.weekStart} onChange={e => setCalendar({ weekStart: Number(e.target.value) === 1 ? 1 : 0 })}><option value={0}>Sunday</option><option value={1}>Monday</option></select>
    </label>
    <label className="cal-setting">Reminder for new events
      <select value={config.calendar.defaultReminder ?? ''} onChange={e => setCalendar({ defaultReminder: e.target.value === '' ? null : Number(e.target.value) })}>
        <option value="">None</option><option value={0}>At the start</option><option value={5}>5 minutes before</option><option value={10}>10 minutes before</option><option value={15}>15 minutes before</option><option value={30}>30 minutes before</option><option value={60}>1 hour before</option>
      </select>
    </label>
    <p className="hint">{isMac ? 'The first time, macOS asks to let BridgeDeck see your calendars and reminders.' : 'Apple Calendar is read on your Mac and shown here; it needs BridgeDeck running there.'} Reminders use the “Checklist items and events” notification setting.</p>
  </Card>
}

export const calendar: FeatureManifest = { id: 'calendar', title: 'Calendar', icon: CalendarDays, Page: CalendarPage, keepAlive: false, Background: CalendarBackground, Settings: CalendarSettings, settingsOrder: 40 }
