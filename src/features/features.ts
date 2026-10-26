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
  /** Fixed tab content. Once opened it stays loaded; `active` is false while another tab is showing.
   *  Its refreshes keep going for a minute after that, then pause (core/awake.ts useTabAwake). */
  Page?: ComponentType<{ active: boolean }>
  /** A page that matters before it's first opened (with `mountAtStart`). */
  keepAlive?: boolean
  /** Load the page at start-up, before it's opened (it polls for notifications). */
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
