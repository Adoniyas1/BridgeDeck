export default function StatusPill({ online, label }: { online: boolean; label?: string }) {
  return <span className={online ? 'status-pill online' : 'status-pill offline'}><i />{label ?? (online ? 'Online' : 'Offline')}</span>
}
