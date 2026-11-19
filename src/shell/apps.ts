import { Settings, type LucideIcon } from 'lucide-react'
import { GROUPS } from '../features/groups'
import { features } from '../features/registry'
import type { Store } from '../core/store'
import { activateTab, openWebTab, replaceTab } from '../core/tabs'

/** One app in the launcher and on the start page. */
export type App = { id: string; title: string; icon: LucideIcon; color: string; area: string; about: string; badge?: Store<number> }

/** Each app's colour on its tile (as Microsoft's app launcher gives each app one). */
const COLOR: Record<string, string> = {
  home: '#5b8def', computers: '#4f9dde', files: '#2fa37a', messages: '#34c759', mail: '#3d7bf5',
  notes: '#f5a623', calendar: '#e5534b', projects: '#8c6bf2', study: '#5e9e3e', logic: '#16a3b5',
  code: '#6b7280', cad: '#d9822b', browser: '#2f80ed', tv: '#d6336c', spotify: '#1db954',
  manga: '#c2410c', mimir: '#7c3aed', ai: '#0ea5e9', settings: '#64748b',
}

/** A line about each app, for the tiles' tooltips and the search on the start page. */
const ABOUT: Record<string, string> = {
  home: 'Today: agenda, health of your computers, briefs',
  computers: 'Your paired computers, remote control and updates',
  files: 'Send files and keep folders in sync',
  messages: 'iMessages from the Mac',
  mail: 'Outlook, Gmail, iCloud and Yahoo mail',
  notes: 'Notes, checklists and calculations',
  calendar: 'Day, week and month',
  projects: 'Project folders, task boards and KiCad',
  study: 'Courses, books, flashcards and exams',
  logic: 'Logic circuits and truth tables',
  code: 'Write and run programs',
  cad: 'SolidCraft and parametric parts',
  browser: 'A new web page',
  tv: 'Streaming sites',
  spotify: 'Music',
  manga: 'Comics and manga',
  mimir: 'Your assistant',
  ai: 'AI agents working together',
  settings: 'BridgeDeck’s settings',
}

const AREA: Record<string, string> = { home: 'Home', devices: 'Devices', inbox: 'Inbox', plan: 'Plan', study: 'Study', media: 'Media', ai: 'AI' }

let made: App[] | null = null
/** Every app, in the order of the areas (as the old tab bar grouped them), then Settings. Made on
 *  first use: the app list (features/registry) imports the pages that show this one. */
export function apps(): App[] {
  made ??= [
    ...GROUPS.flatMap(group => group.items.flatMap(id => {
      const f = features.find(feature => feature.id === id && feature.Page)
      return f ? [{ id: f.id, title: f.title, icon: f.icon, color: COLOR[f.id] ?? '#64748b', area: AREA[group.id] ?? group.title, about: ABOUT[f.id] ?? '', badge: f.badge }] : []
    })),
    { id: 'settings', title: 'Settings', icon: Settings, color: COLOR.settings, area: 'BridgeDeck', about: ABOUT.settings },
  ]
  return made
}

/** The areas with their apps, in order. */
export function areas(): Array<{ area: string; apps: App[] }> {
  const all = apps()
  return [...new Set(all.map(a => a.area))].map(area => ({ area, apps: all.filter(a => a.area === area) }))
}

/** An app by id (feature id or "settings"). */
export const appOf = (id: string) => apps().find(a => a.id === id)

/** Apps whose name or description matches what was typed. */
export function findApps(query: string): App[] {
  const q = query.trim().toLowerCase()
  if (!q) return apps()
  return apps().filter(a => a.title.toLowerCase().includes(q) || a.about.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)))
}

/** Opens an app: in its own tab (the Browser: a new web page), or in place of a new tab `from`. */
export function launch(id: string, from?: string) {
  if (id === 'browser') { openWebTab('', from); return }
  if (from) replaceTab(from, id)
  else activateTab(id)
}
