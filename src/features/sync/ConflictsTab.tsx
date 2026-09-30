import { useEffect, useState } from 'react'
import { Check, FolderOpen, RefreshCw } from 'lucide-react'
import { openPath, syncConflicts, syncResolveConflict } from '../../lib/bridge'
import { setNotice } from '../../core/notice'
import type { DynamicTab } from '../../core/tabs'
import { fmtSize, errorText, shortPath } from '../../core/util'
import type { SyncConflict } from '../../types'
import { Card, SectionTitle } from '../../ui'
import { scanConflicts } from './state'

const when = (ms: number) => ms ? new Date(ms).toLocaleString() : '—'

/** A tab listing one shared folder's conflict copies, with "keep this one" for each. */
export default function ConflictsTab({ tab, active }: { tab: DynamicTab; active: boolean }) {
  const path = String(tab.params?.path ?? '')
  const [items, setItems] = useState<SyncConflict[]>([])
  const [busy, setBusy] = useState('')

  const load = async () => setItems(await syncConflicts(path).catch(() => []))
  useEffect(() => { if (active) void load() }, [active, path])

  async function keep(item: SyncConflict, which: 'current' | 'conflict') {
    setBusy(item.conflictPath)
    try {
      await syncResolveConflict(path, item.conflictPath, which)
      setNotice(`Kept the ${which === 'current' ? 'current' : 'other'} version of ${shortPath(item.originalPath)}; the other one is in the Trash.`)
      await load()
      void scanConflicts()
    } catch (error) {
      setNotice(errorText(error, 'Could not resolve the conflict'))
    } finally {
      setBusy('')
    }
  }

  return <Card><SectionTitle title={`Conflicts in ${String(tab.params?.label ?? path)}`} subtitle="Each file was changed on two computers before they synced. Keep one version; the other goes to the Trash." action={<button className="icon-button" onClick={() => void load()}><RefreshCw size={16}/></button>} />
    {items.length ? <div className="conflict-list">{items.map(item => <div className="conflict-row" key={item.conflictPath}>
      <strong>{shortPath(item.originalPath)}</strong>
      <div className="conflict-versions">
        <div><span>Current</span><small>{item.originalExists ? `${fmtSize(item.originalSize)} · ${when(item.originalModified)}` : 'deleted'}</small>{item.originalExists && <button className="ghost" onClick={() => void openPath(item.originalPath)}><FolderOpen size={14}/>Open</button>}<button disabled={!!busy || !item.originalExists} onClick={() => void keep(item, 'current')}><Check size={14}/>Keep this</button></div>
        <div><span>Other computer's version</span><small>{fmtSize(item.conflictSize)} · {when(item.conflictModified)}</small><button className="ghost" onClick={() => void openPath(item.conflictPath)}><FolderOpen size={14}/>Open</button><button disabled={!!busy} onClick={() => void keep(item, 'conflict')}><Check size={14}/>Keep this</button></div>
      </div>
    </div>)}</div> : <div className="bb-placeholder">No conflicts left in this folder.</div>}
  </Card>
}
