import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Store } from '../core/store'
import type { DynamicTab } from '../core/tabs'

/** Everything the shell knows about a feature. Adding a feature means adding one of these to
 *  `registry.ts`; the tab bar, Settings and background work are built from that list. */
export type FeatureManifest = {
  id: string
  title: string
  icon: LucideIcon
  /** Fixed tab content. `active` is false while another tab is showing (only `keepAlive` pages stay mounted). */
  Page?: ComponentType<{ active: boolean }>
  /** Keep the page mounted while hidden once it has been opened (a web page keeps playing). */
  keepAlive?: boolean
  /** Mount the kept-alive page at start-up, before it's opened (it polls for notifications). */
  mountAtStart?: boolean
  /** Mounted once after the config loads, for polling and native state; renders nothing. */
  Background?: ComponentType
  /** Section of the Settings tab; lower `settingsOrder` comes first. */
  Settings?: ComponentType
  settingsOrder?: number
  /** Count shown on the feature's tab. */
  badge?: Store<number>
  /** Components for dynamic tabs this feature opens with `openTab({ kind, … })`. */
  tabKinds?: Record<string, ComponentType<{ tab: DynamicTab; active: boolean }>>
}
