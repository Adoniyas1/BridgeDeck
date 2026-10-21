import { useEffect, useState } from 'react'
import { ArchiveRestore, Download, Save, Upload } from 'lucide-react'
import { backupExport, backupImport, backupNow, backupRestore, backupsList, isTauri, pickBackupFile, type BackupInfo } from '../../lib/bridge'
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
  const [parts, setParts] = useState({ notes: true, events: true, study: true, settings: false })

  const load = () => void backupsList().then(setList).catch(e => { setList([]); setMessage(errorText(e, 'Couldn’t read the backups')) })
  useEffect(() => { if (isTauri()) load() }, [])

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setMessage('')
    try { await action() } catch (e) { setMessage(errorText(e, 'That didn’t work')) } finally { setBusy('') }
  }

  const backUp = () => run('now', async () => { await backupNow(); setMessage('Backed up.'); load() })

  const exportAll = () => run('export', async () => {
    const path = await pickBackupFile('save')
    if (path) setMessage(await backupExport(path))
  })

  const importAll = () => run('import', async () => {
    const path = await pickBackupFile('open')
    if (!path) return
    const withSettings = window.confirm('Also bring back the settings from that file? (OK: yes. Cancel: keep this computer’s settings.) Its devices and pairing stay as they are here either way.')
    const done = await backupImport(path, withSettings)
    if (done.settings) setConfig(current => ({ ...mergeConfig(done.settings as Partial<AppConfig>), devices: current.devices, pairing: current.pairing, localsend: current.localsend }))
    await refreshNotes()
    setMessage(`Imported ${done.notes} note${done.notes === 1 ? '' : 's'}, ${done.events} event${done.events === 1 ? '' : 's'}${done.study ? `, ${done.study} Study file${done.study === 1 ? '' : 's'}` : ''}${done.settings ? ', settings' : ''}, and the circuits and programs (a file that was already here with other contents is kept, with the imported one beside it as “(imported)”).`)
    load()
  })

  const restore = (b: BackupInfo) => run(b.path, async () => {
    const done = await backupRestore(b.path, parts.notes, parts.events, parts.settings && b.mine, parts.study && b.study > 0)
    if (done.settings) {
      // Settings from this computer's own backup; its devices and pairing stay as they are now.
      setConfig(current => ({ ...mergeConfig(done.settings as Partial<AppConfig>), devices: current.devices, pairing: current.pairing, localsend: current.localsend }))
    }
    await refreshNotes()
    setPicked(null)
    setMessage(`Restored ${[parts.notes && `${done.notes} note${done.notes === 1 ? '' : 's'}`, parts.events && `${done.events} event${done.events === 1 ? '' : 's'}`, done.study > 0 && `${done.study} Study file${done.study === 1 ? '' : 's'}`, done.settings && 'settings'].filter(Boolean).join(', ')} from ${b.date}. A backup of how things were just before is in the list too.`)
    load()
  })

  return <Card><SectionTitle title="Backups" subtitle="Every day, notes (with flashcards), the calendar, settings and Study’s course settings, term and ticked problems are copied to the shared folder, so both computers keep two weeks of them." />
    <div className="actions">
      <button disabled={!!busy || !isTauri()} onClick={() => void backUp()}><Save size={14} /> {busy === 'now' ? 'Backing up…' : 'Back up now'}</button>
      <button className="secondary" disabled={!!busy || !isTauri()} onClick={() => void exportAll()} title="Notes, calendar, settings, circuits and programs in one .zip: for a new computer, a reinstall, or keeping a copy somewhere else"><Download size={14} /> {busy === 'export' ? 'Exporting…' : 'Export everything…'}</button>
      <button className="secondary" disabled={!!busy || !isTauri()} onClick={() => void importAll()} title="Bring back an export made with Export everything"><Upload size={14} /> {busy === 'import' ? 'Importing…' : 'Import…'}</button>
    </div>
    {message && <p className="hint">{message}</p>}
    {list && !list.length && <p className="hint">No backups yet. The first is made a minute or two after BridgeDeck starts.</p>}
    {!!list?.length && <div className="backup-list">{list.slice(0, 30).map(b => <div key={b.path} className="backup-row">
      <div className="grow"><strong>{new Date(b.made).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</strong><small>{b.computer}{b.mine ? ' (this computer)' : ''} · {b.notes} notes · {b.events} events{b.study > 0 ? ` · ${b.study} Study files` : ''} · {fmtSize(b.bytes)}</small></div>
      {picked?.path === b.path
        ? <div className="backup-restore">
            <label><input type="checkbox" checked={parts.notes} onChange={e => setParts({ ...parts, notes: e.target.checked })} /> Notes</label>
            <label><input type="checkbox" checked={parts.events} onChange={e => setParts({ ...parts, events: e.target.checked })} /> Calendar</label>
            {b.study > 0 && <label title="Course settings, the term, ticked problems and the degree plan (not books)"><input type="checkbox" checked={parts.study} onChange={e => setParts({ ...parts, study: e.target.checked })} /> Study</label>}
            <label title={b.mine ? '' : 'Only this computer’s own backups carry its settings'}><input type="checkbox" disabled={!b.mine} checked={parts.settings && b.mine} onChange={e => setParts({ ...parts, settings: e.target.checked })} /> Settings</label>
            <button disabled={!!busy || !(parts.notes || parts.events || (parts.study && b.study > 0) || (parts.settings && b.mine))} onClick={() => void restore(b)}>{busy === b.path ? 'Restoring…' : 'Restore'}</button>
            <button className="ghost" onClick={() => setPicked(null)}>Cancel</button>
          </div>
        : <button className="ghost" disabled={!!busy} onClick={() => setPicked(b)}><ArchiveRestore size={14} /> Restore…</button>}
    </div>)}</div>}
    <p className="hint">Restoring puts notes and events back as they were in the backup, on both computers. Anything made since is kept. The shared folder also keeps 30 days of earlier versions of every file (in its .stversions folder).</p>
  </Card>
}
