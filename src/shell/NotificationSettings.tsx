import { setConfig, useConfig } from '../core/config'
import type { NotifyKind } from '../core/notify'
import { Card, SectionTitle, Toggle } from '../ui'

const KINDS: Array<[NotifyKind, string]> = [
  ['messages', 'New iMessages and texts'],
  ['ai', 'Messages from AI agents'],
  ['files', 'Files received, and requests to send you files'],
  ['sync', 'Sync conflicts (a file changed on two computers)'],
  ['updates', 'BridgeDeck updates on GitHub'],
]

export default function NotificationSettings() {
  const notifications = useConfig().notifications
  const set = (kind: NotifyKind, on: boolean) => setConfig(c => ({ ...c, notifications: { ...c.notifications, [kind]: on } }))
  return <Card><SectionTitle title="Notifications" subtitle="Desktop notifications while BridgeDeck runs, even in the tray" />
    {KINDS.map(([kind, label]) => <Toggle key={kind} checked={notifications[kind]} onChange={on => set(kind, on)} label={label} />)}
    <p className="vendor-note">Remote control starting and pairing requests always notify: they mean another device is reaching this computer.</p>
  </Card>
}
