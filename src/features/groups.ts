import { Bot, FolderKanban, GraduationCap, Home, Inbox, MonitorSmartphone, Play, type LucideIcon } from 'lucide-react'

/** The main tabs: each groups a few features (its sub-tabs, shown when the pointer is over it). A group
 *  with one feature is a plain tab. Any feature can also be pinned to the bar on its own. */
export type TabGroup = { id: string; title: string; icon: LucideIcon; items: string[] }

export const GROUPS: TabGroup[] = [
  { id: 'home', title: 'Home', icon: Home, items: ['home'] },
  { id: 'devices', title: 'Devices', icon: MonitorSmartphone, items: ['computers', 'files'] },
  { id: 'inbox', title: 'Inbox', icon: Inbox, items: ['messages', 'mail'] },
  { id: 'plan', title: 'Plan', icon: FolderKanban, items: ['notes', 'calendar', 'projects'] },
  { id: 'study', title: 'Study', icon: GraduationCap, items: ['study', 'logic', 'manga'] },
  { id: 'media', title: 'Media', icon: Play, items: ['browser', 'tv', 'spotify'] },
  { id: 'ai', title: 'AI', icon: Bot, items: ['mimir', 'ai'] },
]

/** The group a feature (or a dynamic tab's feature) belongs to. */
export const groupOf = (featureId: string) => GROUPS.find(group => group.items.includes(featureId))
