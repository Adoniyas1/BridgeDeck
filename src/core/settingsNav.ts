import { createStore } from './store'
import { activateTab } from './tabs'

/** A Settings section to show next (Settings picks it up and clears it). */
export const settingsSectionStore = createStore<string | null>(null)

export function openSettings(section: string) {
  settingsSectionStore.set(section)
  activateTab('settings')
}
