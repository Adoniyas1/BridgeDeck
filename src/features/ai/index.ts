import { useEffect, lazy } from 'react'
import { Bot } from 'lucide-react'
import { isTauri, notificationSettings } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { useStore } from '../../core/store'
import { usePeriodicRefresh } from '../../core/refresh'
import type { FeatureManifest } from '../features'
import RoomTab from './RoomTab'
import { openRoomsStore, refreshWorkspace } from './state'
const AiPage = lazy(() => import('./AiPage'))

/** Keeps the open-room count on the tab current while the page is closed. */
function AiBackground() {
  usePeriodicRefresh(refreshWorkspace, 15000, [])
  // Incoming AI messages are announced by the native side.
  const notifyAi = useStore(configStore).notifications.ai
  useEffect(() => { if (isTauri()) void notificationSettings(notifyAi).catch(() => undefined) }, [notifyAi])
  return null
}

export const ai: FeatureManifest = { id: 'ai', title: 'AI Center', icon: Bot, Page: AiPage, Background: AiBackground, tabKinds: { 'ai-room': RoomTab }, badge: openRoomsStore }
