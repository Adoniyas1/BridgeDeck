import { useEffect, useState } from 'react'
import { ArchiveRestore, Save } from 'lucide-react'
import { backupNow, backupRestore, backupsList, isTauri, type BackupInfo } from '../../lib/bridge'
import { mergeConfig } from '../../lib/config'
import { setConfig } from '../../core/config'
import { errorText, fmtSize } from '../../core/util'
import { refreshNotes } from '../notes/state'
import { Card, SectionTitle } from '../../ui'
import type { AppConfig } from '../../types'

/** Settings → Sync: the daily backups in the shared folder, and putting one back. */
export default function BackupsCard() {
  const [list, setList] = useState<BackupInfo[] | null>(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [picked, setPicked] = useState<BackupInfo | null>(null)
  const [parts, setParts] = useState({ notes: true, events: true, settings: false })

  const load = () => void backupsList().then(setList).catch(e => { setList([]); setMessage(errorText(e, 'Couldn’t read the backups')) })
  useEffect(() => { if (isTauri()) load() }, [])

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setMessage('')
    try { await action() } catch (e) { setMessage(errorText(e, 'That didn’t work')) } finally { setBusy('') }
  }

  const backUp = () => run('now', async () => { await backupNow(); setMessage('Backed up.'); load() })

  const restore = (b: BackupInfo) => run(b.path, async () => {
    const done = await backupRestore(b.path, parts.notes, parts.events, parts.settings && b.mine)
    if (done.settings) {
      // Settings from this computer's own backup; its devices and pairing stay as they are now.
      setConfig(current => ({ ...mergeConfig(done.settings as Partial<AppConfig>), devices: current.devices, pairing: current.pairing, localsend: current.localsend }))
    }
    await refreshNotes()
    setPicked(null)
    setMessage(`Restored ${[parts.notes && `${done.notes} note${done.notes === 1 ? '' : 's'}`, parts.events && `${done.events} event${done.events === 1 ? '' : 's'}`, done.settings && 'settings'].filter(Boolean).join(', ')} from ${b.date}. A backup of how things were just before is in the list too.`)
    load()
  })

  return <Card><SectionTitle title="Backups" subtitle="Every day, notes (with flashcards), the calendar and settings are copied to the shared folder, so both computers keep two weeks of them." />
    <div className="actions"><button disabled={!!busy || !isTauri()} onClick={() => void backUp()}><Save size={14} /> {busy === 'now' ? 'Backing up…' : 'Back up now'}</button></div>
    {message && <p className="hint">{message}</p>}
    {list && !list.length && <p className="hint">No backups yet. The first is made a minute or two after BridgeDeck starts.</p>}
    {!!list?.length && <div className="backup-list">{list.slice(0, 30).map(b => <div key={b.path} className="backup-row">
      <div className="grow"><strong>{new Date(b.made).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</strong><small>{b.computer}{b.mine ? ' (this computer)' : ''} · {b.notes} notes · {b.events} events · {fmtSize(b.bytes)}</small></div>
      {picked?.path === b.path
        ? <div className="backup-restore">
            <label><input type="checkbox" checked={parts.notes} onChange={e => setParts({ ...parts, notes: e.target.checked })} /> Notes</label>
            <label><input type="checkbox" checked={parts.events} onChange={e => setParts({ ...parts, events: e.target.checked })} /> Calendar</label>
            <label title={b.mine ? '' : 'Only this computer’s own backups carry its settings'}><input type="checkbox" disabled={!b.mine} checked={parts.settings && b.mine} onChange={e => setParts({ ...parts, settings: e.target.checked })} /> Settings</label>
            <button disabled={!!busy || !(parts.notes || parts.events || (parts.settings && b.mine))} onClick={() => void restore(b)}>{busy === b.path ? 'Restoring…' : 'Restore'}</button>
            <button className="ghost" onClick={() => setPicked(null)}>Cancel</button>
          </div>
        : <button className="ghost" disabled={!!busy} onClick={() => setPicked(b)}><ArchiveRestore size={14} /> Restore…</button>}
    </div>)}</div>}
    <p className="hint">Restoring puts notes and events back as they were in the backup, on both computers. Anything made since is kept.</p>
  </Card>
}
