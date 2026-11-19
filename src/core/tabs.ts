import { createStore } from './store'

/** A tab that comes and goes with its own kind of view (a web page, a book, a remote session, a new
 *  tab…). App pages and Settings are tabs too, by their feature id; any tab can be opened and closed,
 *  like a browser's. */
export type DynamicTab = {
  id: string
  /** Picks the component: a feature registers `tabKinds[kind]`. */
  kind: string
  title: string
  params?: Record<string, unknown>
}

export type TabsState = {
  active: string
  dynamic: DynamicTab[]
  /** Most recently activated first; closing the active tab returns to the previous one. */
  history: string[]
  /** Split screen: the tab shown on the right beside the active one (two books, a book and its
   *  notes…), or null. */
  split?: string | null
  /** The open tabs, in the bar's order (app pages by feature id, Settings, dynamic tabs by id). */
  open?: string[]
  /** Closed tabs, the last one first, to open again (Ctrl Shift T). */
  closed?: Array<string | DynamicTab>
}

export const initialTabs: TabsState = { active: 'home', dynamic: [], history: ['home'], split: null, open: ['home'], closed: [] }

/** Pages merged into another: Remote is part of Computers, Sync part of Files. Opening the old id
 *  (a link, a notification, the palette) opens the page it's in now. */
export const TAB_ALIASES: Record<string, string> = { remote: 'computers', sync: 'files' }

const MAX_CLOSED = 25

/** The open tabs (states made before tabs could close list only the active one). */
export const openOf = (state: TabsState): string[] => state.open ?? [state.active]

/** The tabs in the bar's order: pinned ones first, then the rest as arranged. */
export function barOrder(state: TabsState, pins: string[]): string[] {
  const open = openOf(state)
  return [...pins.filter(id => open.includes(id)), ...open.filter(id => !pins.includes(id))]
}

/** Puts `id` in the bar, just after the tab that's showing (as a browser opens a link's tab). */
function withOpen(state: TabsState, id: string): string[] {
  const open = openOf(state)
  if (open.includes(id)) return open
  const at = open.indexOf(state.active)
  return at < 0 ? [...open, id] : [...open.slice(0, at + 1), id, ...open.slice(at + 1)]
}

export function activateIn(state: TabsState, requested: string): TabsState {
  const id = TAB_ALIASES[requested] ?? requested
  const open = withOpen(state, id)
  if (state.active === id && open === openOf(state)) return state
  // Picking the tab on the right swaps the two sides; the split stays.
  const split = state.split === id ? state.active : state.split ?? null
  return { ...state, open, active: id, split, history: [id, ...state.history.filter(entry => entry !== id)] }
}

/** Shows `requested` on the right beside the active tab. When it's the active tab itself, the tab
 *  used before it takes the left. */
export function splitIn(state: TabsState, requested: string): TabsState {
  const id = TAB_ALIASES[requested] ?? requested
  if (id !== state.active) return { ...state, open: withOpen(state, id), split: id }
  const other = state.history.find(entry => entry !== id && openOf(state).includes(entry)) ?? (id === 'home' ? null : 'home')
  if (!other) return state
  return { ...activateIn({ ...state, split: null }, other), split: id }
}

export const unsplitIn = (state: TabsState): TabsState => state.split ? { ...state, split: null } : state

/** Opens `tab` and makes it active; a tab with the same id is reused (and retitled) instead of duplicated. */
export function openIn(state: TabsState, tab: DynamicTab): TabsState {
  const exists = state.dynamic.some(entry => entry.id === tab.id)
  const dynamic = exists ? state.dynamic.map(entry => entry.id === tab.id ? { ...entry, ...tab } : entry) : [...state.dynamic, tab]
  return activateIn({ ...state, dynamic }, tab.id)
}

/** Closes a tab. The one used before it is shown (or its neighbour); closing the last tab leaves Home. */
export function closeIn(state: TabsState, id: string): TabsState {
  const open = openOf(state)
  if (!open.includes(id) && !state.dynamic.some(tab => tab.id === id)) return state
  const tab = state.dynamic.find(entry => entry.id === id)
  const dynamic = state.dynamic.filter(entry => entry.id !== id)
  let left = open.filter(entry => entry !== id)
  if (!left.length) left = ['home']
  const history = state.history.filter(entry => entry !== id && left.includes(entry))
  const near = left[Math.min(Math.max(open.indexOf(id), 0), left.length - 1)]
  const active = state.active === id ? history[0] ?? near : state.active
  // The split ends when either side closes (or when what's left would be on both sides).
  const split = state.split && state.split !== id && state.split !== active && state.active !== id ? state.split : null
  // A new tab that was never used isn't worth opening again.
  const closed = tab?.kind === 'newtab' ? state.closed ?? [] : [tab ?? id, ...(state.closed ?? []).filter(c => (typeof c === 'string' ? c : c.id) !== id)].slice(0, MAX_CLOSED)
  return { ...state, dynamic, open: left, history: history.length ? history : [active], active, split, closed }
}

/** Closes every tab but `keep` and the pinned ones. */
export function closeOthersIn(state: TabsState, keep: string, pinned: string[] = []): TabsState {
  return openOf(state).filter(id => id !== keep && !pinned.includes(id)).reduce(closeIn, activateIn(state, keep))
}

/** Closes the tabs to the right of `id` (not pinned ones). */
export function closeRightIn(state: TabsState, id: string, pinned: string[] = []): TabsState {
  const open = openOf(state)
  return open.slice(open.indexOf(id) + 1).filter(entry => !pinned.includes(entry)).reduce(closeIn, state)
}

/** Opens the tab closed last again, where a link would open it. */
export function reopenIn(state: TabsState): TabsState {
  const [last, ...rest] = state.closed ?? []
  if (!last) return state
  const next = { ...state, closed: rest }
  return typeof last === 'string' ? activateIn(next, last) : openIn(next, last)
}

/** Moves a tab to `index` in the bar (dragged there). */
export function moveIn(state: TabsState, id: string, index: number): TabsState {
  const open = openOf(state)
  if (!open.includes(id)) return state
  const rest = open.filter(entry => entry !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  const moved = [...rest.slice(0, at), id, ...rest.slice(at)]
  return moved.every((entry, i) => entry === open[i]) ? state : { ...state, open: moved }
}

/** A new tab turned into what was picked in it: `to` (an app page, or a dynamic tab) takes its place
 *  in the bar; if `to` is already open elsewhere, the new tab just goes and that one shows. */
export function replaceIn(state: TabsState, from: string, to: string | DynamicTab): TabsState {
  const id = typeof to === 'string' ? TAB_ALIASES[to] ?? to : to.id
  const open = openOf(state)
  const at = open.indexOf(from)
  const already = open.includes(id)
  let next: TabsState = { ...state, dynamic: state.dynamic.filter(t => t.id !== from), history: state.history.filter(h => h !== from) }
  if (typeof to !== 'string') next = { ...next, dynamic: next.dynamic.some(t => t.id === id) ? next.dynamic.map(t => t.id === id ? { ...t, ...to } : t) : [...next.dynamic, to] }
  const without = open.filter(entry => entry !== from)
  next.open = already || at < 0 ? without : [...without.slice(0, at), id, ...without.slice(at)]
  const split = next.split === from ? null : next.split
  return activateIn({ ...next, split, active: already ? next.active : id }, id)
}

// ---- Kept between runs, as a browser keeps its tabs ----

const SAVE_KEY = 'bridgedeck.tabs'
/** Dynamic tabs that open again after a restart (a web page, a book, a lecture, a new tab); others
 *  (a remote session, a transfer) belong to that run. */
const RESTORED_KINDS = new Set(['web', 'study-book', 'study-lecture', 'newtab'])

export type SavedTabs = { open: string[]; active: string; dynamic: DynamicTab[] }

export function saveable(state: TabsState): SavedTabs {
  const dynamic = state.dynamic.filter(tab => RESTORED_KINDS.has(tab.kind))
  const keepIds = new Set(dynamic.map(tab => tab.id))
  const isDynamic = (id: string) => state.dynamic.some(tab => tab.id === id)
  const open = openOf(state).filter(id => !isDynamic(id) || keepIds.has(id))
  return { open, active: open.includes(state.active) ? state.active : open[0] ?? 'home', dynamic }
}

/** The tabs saved last time, keeping only ids `valid` accepts (pages that still exist). */
export function restored(saved: unknown, valid: (id: string) => boolean): TabsState {
  if (!saved || typeof saved !== 'object') return initialTabs
  const s = saved as Partial<SavedTabs>
  const dynamic = (Array.isArray(s.dynamic) ? s.dynamic : []).filter((t): t is DynamicTab => !!t && typeof t.id === 'string' && typeof t.kind === 'string' && typeof t.title === 'string' && RESTORED_KINDS.has(t.kind))
  const ids = new Set(dynamic.map(t => t.id))
  const open = [...new Set((Array.isArray(s.open) ? s.open : []).filter((id): id is string => typeof id === 'string' && (ids.has(id) || valid(id))))]
  if (!open.length) return initialTabs
  const active = typeof s.active === 'string' && open.includes(s.active) ? s.active : open[0]
  return { active, open, dynamic: dynamic.filter(t => open.includes(t.id)), history: [active, ...open.filter(id => id !== active)], split: null, closed: [] }
}

export function loadSavedTabs(valid: (id: string) => boolean): TabsState {
  try { return restored(JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null'), valid) } catch { return initialTabs }
}

export const tabsStore = createStore<TabsState>(initialTabs)

/** Saves the tabs as they change (from when the app has put back last time's). */
export function keepTabs() {
  let last = ''
  return tabsStore.subscribe(() => {
    const text = JSON.stringify(saveable(tabsStore.get()))
    if (text === last) return
    last = text
    try { localStorage.setItem(SAVE_KEY, text) } catch { /* this run only */ }
  })
}

/** Shows a tab, opening it if it isn't open. The Browser app is a new web page now (its own tabs
 *  are the bar's), so asking for it opens one. */
export const activateTab = (id: string) => { if (id === 'browser') openWebTab(''); else tabsStore.set(state => activateIn(state, id)) }
export const closeTab = (id: string) => tabsStore.set(state => closeIn(state, id))
export const splitTab = (id: string) => tabsStore.set(state => splitIn(state, id))
export const unsplit = () => tabsStore.set(unsplitIn)
export const moveTab = (id: string, index: number) => tabsStore.set(state => moveIn(state, id, index))
export const reopenClosedTab = () => tabsStore.set(reopenIn)
export const closeOtherTabs = (keep: string, pinned: string[]) => tabsStore.set(state => closeOthersIn(state, keep, pinned))
export const closeTabsRight = (id: string, pinned: string[]) => tabsStore.set(state => closeRightIn(state, id, pinned))
/** A new tab turns into what was picked in it (an app, or a web page). */
export const replaceTab = (from: string, to: string | DynamicTab) => tabsStore.set(state => replaceIn(state, from, to))
/** Changes an open tab's title (a web page's title changed) without switching to it. */
export const retitleTab = (id: string, title: string) => tabsStore.set(state => state.dynamic.some(t => t.id === id && t.title !== title) ? { ...state, dynamic: state.dynamic.map(t => t.id === id ? { ...t, title } : t) } : state)

/** Opens a dynamic tab on the right of a split screen, beside the tab that's showing. */
export function openBeside(tab: DynamicTab): void {
  tabsStore.set(state => {
    const exists = state.dynamic.some(entry => entry.id === tab.id)
    const dynamic = exists ? state.dynamic.map(entry => entry.id === tab.id ? { ...entry, ...tab } : entry) : [...state.dynamic, tab]
    return splitIn({ ...state, dynamic }, tab.id)
  })
}

/** Opens a dynamic tab. Pass a stable `id` (for example `remote:<device>`) to reuse an existing tab. */
export function openTab(tab: Omit<DynamicTab, 'id'> & { id?: string }): string {
  const id = tab.id ?? `${tab.kind}:${crypto.randomUUID()}`
  tabsStore.set(state => openIn(state, { ...tab, id }))
  return id
}

/** A new tab: the start page, with the search box and the apps. */
export const newTab = () => openTab({ kind: 'newtab', title: 'New tab' })

/** A web page in a tab of its own, at `url` (empty: the start page's search). */
export function openWebTab(url: string, replace?: string): string {
  const page = `web-${crypto.randomUUID().slice(0, 12)}`
  const tab: DynamicTab = { id: `web:${page}`, kind: 'web', title: url ? url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) : 'New tab', params: { page, url } }
  if (replace) replaceTab(replace, tab)
  else tabsStore.set(state => openIn(state, tab))
  return tab.id
}
