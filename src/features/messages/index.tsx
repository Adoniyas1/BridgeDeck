import { lazy } from 'react'
import { MessageSquare } from 'lucide-react'
import { useStore } from '../../core/store'
import type { FeatureManifest } from '../features'
import { checkMessagesSource, checkingSourceStore, MessagesBackground, messagesSourceStore, messagesUnreadStore } from './state'
const Messages = lazy(() => import('./Messages'))

function MessagesPage({ active }: { active: boolean }) {
  const source = useStore(messagesSourceStore)
  const checking = useStore(checkingSourceStore)
  return <Messages source={source} visible={active} onUnreadChange={messagesUnreadStore.set} onCheckAgain={checkMessagesSource} checking={checking} />
}

/** Messages stays mounted: it keeps polling for desktop notifications and the unread badge on every tab. */
export const messages: FeatureManifest = {
  id: 'messages', title: 'Messages', icon: MessageSquare, Page: MessagesPage, keepAlive: true,
  Background: MessagesBackground, badge: messagesUnreadStore,
}
