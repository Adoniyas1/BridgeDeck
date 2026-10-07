import { useEffect, useState } from 'react'
import { Bug, ClipboardCopy, FolderOpen, Trash2 } from 'lucide-react'
import { errorLogClear, errorLogRead, isTauri, openPath, type ErrorLog } from '../lib/bridge'
import { setNotice } from '../core/notice'
import { errorText } from '../core/util'
import { Card, SectionTitle } from '../ui'
import { version } from '../../package.json'

/** The report pasted when something goes wrong: version, system, and the log's last part. */
export function errorReport(log: ErrorLog, userAgent: string, now = new Date()) {
  return [
    `BridgeDeck ${version} error report, ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `System: ${userAgent}`,
    `${log.entries} entr${log.entries === 1 ? 'y' : 'ies'}, ${log.crashes} crash${log.crashes === 1 ? '' : 'es'}`,
    '',
    log.text.trim() || '(the log is empty)',
  ].join('\n')
}

/** Settings → Errors and crashes: what went wrong on this computer, ready to copy into a chat. */
export default function ErrorLogCard() {
  const [log, setLog] = useState<ErrorLog | null>(null)
  const [open, setOpen] = useState(false)
  const load = () => { if (isTauri()) void errorLogRead().then(setLog).catch(() => undefined) }
  useEffect(load, [])
  if (!isTauri()) return null

  async function copy() {
    try {
      const current = await errorLogRead()
      setLog(current)
      await navigator.clipboard.writeText(errorReport(current, navigator.userAgent))
      setNotice('Error report copied. Paste it into your chat with Claude.')
    } catch (e) { setNotice(errorText(e, 'Couldn’t copy the error report')) }
  }

  async function clear() {
    if (!window.confirm('Clear the error log on this computer?')) return
    try { await errorLogClear(); load() } catch (e) { setNotice(errorText(e, 'Couldn’t clear it')) }
  }

  const entries = log?.entries ?? 0
  return <Card><SectionTitle title="Errors and crashes" subtitle={entries ? `${entries} logged on this computer${log?.crashes ? `, ${log.crashes} crash${log.crashes === 1 ? '' : 'es'}` : ''}` : 'Nothing has gone wrong on this computer'} action={<Bug size={18} />} />
    <div className="actions">
      <button className="secondary" onClick={() => void copy()}><ClipboardCopy size={16} />Copy error report</button>
      {entries > 0 && <button className="secondary" onClick={() => setOpen(v => !v)}>{open ? 'Hide' : 'Show'} log</button>}
      {log?.path && <button className="secondary" onClick={() => void openPath(log.path.replace(/[\\/][^\\/]*$/, '')).catch(() => undefined)}><FolderOpen size={16} />Folder</button>}
      {entries > 0 && <button className="secondary" onClick={() => void clear()}><Trash2 size={16} />Clear</button>}
    </div>
    {open && log && <pre className="error-log">{log.text}</pre>}
    <p className="hint">Crashes, BridgeDeck closing unexpectedly, and errors in the window are kept here (no passwords or message text). The report includes the BridgeDeck version and your system.</p>
  </Card>
}
