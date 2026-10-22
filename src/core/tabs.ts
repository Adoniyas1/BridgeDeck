import { createStore } from './store'

/** A tab that comes and goes (a remote session, an AI room, a transfer). Fixed tabs are the features'
 *  pages and Settings; they are identified by feature id and can't be closed. */
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
}

export const initialTabs: TabsState = { active: 'home', dynamic: [], history: ['home'], split: null }

/** Pages merged into another: Remote is part of Computers, Sync part of Files. Opening the old id
 *  (a link, a notification, the palette) opens the page it's in now. */
export const TAB_ALIASES: Record<string, string> = { remote: 'computers', sync: 'files' }

export function activateIn(state: TabsState, requested: string): TabsState {
  const id = TAB_ALIASES[requested] ?? requested
  if (state.active === id) return state
  // Picking the tab on the right swaps the two sides; the split stays.
  const split = state.split === id ? state.active : state.split ?? null
  return { ...state, active: id, split, history: [id, ...state.history.filter(entry => entry !== id)] }
}

/** Shows `requested` on the right beside the active tab. When it's the active tab itself, the tab
 *  used before it takes the left. */
export function splitIn(state: TabsState, requested: string): TabsState {
  const id = TAB_ALIASES[requested] ?? requested
  if (id !== state.active) return { ...state, split: id }
  const other = state.history.find(entry => entry !== id) ?? (id === 'home' ? null : 'home')
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

export function closeIn(state: TabsState, id: string): TabsState {
  if (!state.dynamic.some(tab => tab.id === id)) return state
  const dynamic = state.dynamic.filter(tab => tab.id !== id)
  const history = state.history.filter(entry => entry !== id)
  const active = state.active === id ? history[0] ?? 'home' : state.active
  // The split ends when either side closes (or when what's left would be on both sides).
  const split = state.split && state.split !== id && state.split !== active && state.active !== id ? state.split : null
  return { dynamic, history: history.length ? history : [active], active, split }
}

export const tabsStore = createStore<TabsState>(initialTabs)

export const activateTab = (id: string) => tabsStore.set(state => activateIn(state, id))
export const closeTab = (id: string) => tabsStore.set(state => closeIn(state, id))
export const splitTab = (id: string) => tabsStore.set(state => splitIn(state, id))
export const unsplit = () => tabsStore.set(unsplitIn)
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
