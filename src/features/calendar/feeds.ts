import { calendarSubscription, isTauri } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { createStore } from '../../core/store'
import { errorText } from '../../core/util'
import type { CalendarFeed } from '../../types'
import { fromIcs } from './ics'
import { addDays, startOfDay, type Item } from './model'
import { occurrences } from './recur'

/** Subscribed calendars (Outlook's published ICS link, Google's secret address…): read every 30
 *  minutes and shown read-only, a few months either side of today. */
export const feedItemsStore = createStore<Item[]>([])
export const feedErrorsStore = createStore<Record<string, string>>({})
const CACHE = 'bridgedeck.calendar.feeds'

try { const cached = JSON.parse(localStorage.getItem(CACHE) ?? '[]'); if (Array.isArray(cached)) feedItemsStore.set(cached) } catch { /* cache only */ }

export function feedItems(feed: CalendarFeed, ics: string, now = Date.now()): Item[] {
  const [from, to] = [addDays(startOfDay(now), -60), addDays(startOfDay(now), 180)]
  return fromIcs(ics).flatMap(event => occurrences(event, from, to).map(o => ({
    key: `feed:${feed.id}:${event.id}:${o.start}`, source: 'feed' as const, title: event.title || 'Event', start: o.start, end: o.end,
    allDay: event.allDay, color: feed.color, calendar: [feed.name, event.location].filter(Boolean).join(' · '),
  })))
}

export async function refreshFeeds() {
  if (!isTauri()) return
  const feeds = configStore.get().calendar.feeds
  const errors: Record<string, string> = {}
  const previous = feedItemsStore.get()
  const lists = await Promise.all(feeds.map(async feed => {
    try { return feedItems(feed, await calendarSubscription(feed.url)) } catch (e) {
      errors[feed.id] = errorText(e, 'Didn’t load')
      // Keeps what it had until the calendar answers again.
      return previous.filter(i => i.key.startsWith(`feed:${feed.id}:`))
    }
  }))
  const items = lists.flat()
  feedItemsStore.set(items)
  feedErrorsStore.set(errors)
  try { localStorage.setItem(CACHE, JSON.stringify(items.slice(0, 3000))) } catch { /* cache only */ }
}
