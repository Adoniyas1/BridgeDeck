import { Bot } from 'lucide-react'
import { usePeriodicRefresh } from '../../core/refresh'
import type { FeatureManifest } from '../features'
import AiPage from './AiPage'
import RoomTab from './RoomTab'
import { openRoomsStore, refreshWorkspace } from './state'

/** Keeps the open-room count on the tab current while the page is closed. */
function AiBackground() {
  usePeriodicRefresh(refreshWorkspace, 15000, [])
  return null
}

export const ai: FeatureManifest = { id: 'ai', title: 'AI Center', icon: Bot, Page: AiPage, Background: AiBackground, tabKinds: { 'ai-room': RoomTab }, badge: openRoomsStore }
