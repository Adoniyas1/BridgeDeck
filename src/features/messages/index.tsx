import { MessageSquare } from 'lucide-react'
import { setConfig, useConfig } from '../../core/config'
import { Card, SectionTitle } from '../../ui'
import type { FeatureManifest } from '../features'
import Messages from './Messages'
import { MessagesBackground, messagesUnreadStore } from './state'

function MessagesPage({ active }: { active: boolean }) {
  const config = useConfig()
  return <Messages baseUrl={config.bluebubbles.baseUrl} password={config.bluebubbles.password} visible={active} onUnreadChange={messagesUnreadStore.set} />
}

function MessagesSettings() {
  const config = useConfig()
  return <Card><SectionTitle title="BlueBubbles" subtitle="Mac-side iMessage service" /><label>Server URL<input value={config.bluebubbles.baseUrl} onChange={e => setConfig(c => ({ ...c, bluebubbles: { ...c.bluebubbles, baseUrl: e.target.value } }))} placeholder="http://127.0.0.1:1234"/></label><label>Server password<input type="password" value={config.bluebubbles.password} onChange={e => setConfig(c => ({ ...c, bluebubbles: { ...c.bluebubbles, password: e.target.value } }))}/></label></Card>
}

/** Messages stays mounted: it keeps polling for desktop notifications and the unread badge on every tab. */
export const messages: FeatureManifest = {
  id: 'messages', title: 'Messages', icon: MessageSquare, Page: MessagesPage, keepAlive: true,
  Background: MessagesBackground, Settings: MessagesSettings, settingsOrder: 50, badge: messagesUnreadStore,
}
