import { useEffect, useState } from 'react'
import { History, X } from 'lucide-react'
import { isTauri, noteVersion, noteVersions, type NoteVersionInfo } from '../../lib/bridge'
import { errorText } from '../../core/util'

const when = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** A note's earlier versions on this computer: pick one to read it, and put it back. */
export function NoteHistory({ noteId, onRestore, onClose }: { noteId: string; onRestore: (at: number) => Promise<void>; onClose: () => void }) {
  const [list, setList] = useState<NoteVersionInfo[] | null>(null)
  const [picked, setPicked] = useState<{ at: number; title: string; markdown: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!isTauri()) { setList([]); return }
    void noteVersions(noteId).then(setList).catch(e => { setList([]); setError(errorText(e, 'Couldn’t read the history')) })
  }, [noteId])
  const pick = (at: number) => void noteVersion(noteId, at).then(setPicked).catch(e => setError(errorText(e, 'Couldn’t open that version')))
  async function restore() {
    if (!picked) return
    setBusy(true)
    try { await onRestore(picked.at); onClose() } catch (e) { setError(errorText(e, 'Couldn’t put it back')) } finally { setBusy(false) }
  }
  return <div className="cal-modal-back" onClick={onClose}>
    <div className="card cal-modal note-history" onClick={e => e.stopPropagation()}>
      <div className="cal-modal-head"><h3><History size={16} /> Earlier versions</h3><button className="cal-icon" onClick={onClose}><X size={15} /></button></div>
      <div className="note-history-body">
        <div className="note-history-list">
          {list === null ? <p className="hint">Reading…</p> : !list.length ? <p className="hint">No earlier versions yet. While you edit, a version is kept every ten minutes on this computer.</p>
            : list.map(v => <button key={v.at} className={picked?.at === v.at ? 'active' : ''} onClick={() => pick(v.at)}><strong>{when(v.at)}</strong><small>{v.title || 'Untitled'} · {v.chars} characters</small></button>)}
        </div>
        <div className="note-history-view">
          {picked ? <><h4>{picked.title || 'Untitled'}</h4><pre>{picked.markdown || '(empty)'}</pre></> : <p className="hint">Pick a version to read it.</p>}
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="actions">
        <button disabled={!picked || busy} onClick={() => void restore()}>{busy ? 'Putting it back…' : 'Put this version back'}</button>
        <small className="hint">The note as it is now is kept as a version first, so this can be undone.</small>
      </div>
    </div>
  </div>
}
