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
}

export const initialTabs: TabsState = { active: 'home', dynamic: [], history: ['home'] }

export function activateIn(state: TabsState, id: string): TabsState {
  if (state.active === id) return state
  return { ...state, active: id, history: [id, ...state.history.filter(entry => entry !== id)] }
}

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
  return { dynamic, history: history.length ? history : [active], active }
}

export const tabsStore = createStore<TabsState>(initialTabs)

export const activateTab = (id: string) => tabsStore.set(state => activateIn(state, id))
export const closeTab = (id: string) => tabsStore.set(state => closeIn(state, id))

/** Opens a dynamic tab. Pass a stable `id` (for example `remote:<device>`) to reuse an existing tab. */
export function openTab(tab: Omit<DynamicTab, 'id'> & { id?: string }): string {
  const id = tab.id ?? `${tab.kind}:${crypto.randomUUID()}`
  tabsStore.set(state => openIn(state, { ...tab, id }))
  return id
}
