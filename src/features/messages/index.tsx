import { MessageSquare } from 'lucide-react'
import { useStore } from '../../core/store'
import type { FeatureManifest } from '../features'
import Messages from './Messages'
import { MessagesBackground, messagesSourceStore, messagesUnreadStore } from './state'

function MessagesPage({ active }: { active: boolean }) {
  const source = useStore(messagesSourceStore)
  return <Messages source={source} visible={active} onUnreadChange={messagesUnreadStore.set} />
}

/** Messages stays mounted: it keeps polling for desktop notifications and the unread badge on every tab. */
export const messages: FeatureManifest = {
  id: 'messages', title: 'Messages', icon: MessageSquare, Page: MessagesPage, keepAlive: true,
  Background: MessagesBackground, badge: messagesUnreadStore,
}
