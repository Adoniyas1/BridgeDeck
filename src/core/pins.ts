import { createStore } from './store'

/** Sub-tabs pinned to the main bar on their own, and the sub-tab last used in each group (what a click
 *  on the group opens). Both are kept on this computer. */
const PINS_KEY = 'bridgedeck.pinnedTabs'
const LAST_KEY = 'bridgedeck.lastInGroup'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function keep(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* this run only */ }
}

export const pinsStore = createStore<string[]>(load<string[]>(PINS_KEY, []).filter(id => typeof id === 'string'))
pinsStore.subscribe(() => keep(PINS_KEY, pinsStore.get()))

export const togglePin = (id: string) => pinsStore.set(pins => pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id])

export const lastInGroupStore = createStore<Record<string, string>>(load(LAST_KEY, {}))
lastInGroupStore.subscribe(() => keep(LAST_KEY, lastInGroupStore.get()))
