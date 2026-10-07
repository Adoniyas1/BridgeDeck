import { useEffect, useRef, useState } from 'react'
import { Lock, LockOpen, X } from 'lucide-react'
import { notesReplaceMarkdown, notesSave, type Note, type NoteBlock } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { lockText, unlockText } from './lock'

/** Locks again after this long without typing. */
const IDLE_MS = 5 * 60_000

/** A locked note: the password opens it for reading and editing here (as Markdown); nothing
 *  readable is saved. Leaving the note, or five idle minutes, locks it again. */
export function LockedNote({ note, block, onSaved }: { note: Note; block: NoteBlock; onSaved: (note: Note) => void }) {
  const [password, setPassword] = useState('')
  const [plain, setPlain] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const idle = useRef<number>()
  const lockNow = () => { setPlain(null); setPassword(''); setDirty(false) }

  useEffect(() => {
    if (plain === null) return
    window.clearTimeout(idle.current)
    idle.current = window.setTimeout(lockNow, IDLE_MS)
    return () => window.clearTimeout(idle.current)
  }, [plain])

  async function open() {
    setBusy(true); setError('')
    try { setPlain(await unlockText(block.text, password)) } catch (e) { setError(errorText(e, 'Couldn’t open it')) } finally { setBusy(false) }
  }

  async function save() {
    if (plain === null) return
    setBusy(true); setError('')
    try {
      const saved = await notesSave({ id: note.id, blocks: [{ ...block, text: await lockText(plain, password) }] })
      onSaved(saved)
      setDirty(false)
    } catch (e) { setError(errorText(e, 'Not saved')) } finally { setBusy(false) }
  }

  async function removeLock() {
    if (plain === null || !window.confirm('Remove the password? The note becomes readable again (and searchable) on every computer.')) return
    setBusy(true)
    try { onSaved(await notesReplaceMarkdown(note.id, plain)) } catch (e) { setError(errorText(e, 'Couldn’t remove the lock')); setBusy(false) }
  }

  if (plain === null) return <form className="locked-note" onSubmit={e => { e.preventDefault(); void open() }}>
    <Lock size={26} />
    <h3>This note is locked</h3>
    <p className="hint">Its content is encrypted on both computers. Enter its password to read it.</p>
    <div className="locked-open"><input type="password" autoFocus placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} /><button disabled={!password || busy}>{busy ? 'Opening…' : 'Open'}</button></div>
    {error && <p className="error-text">{error}</p>}
  </form>

  return <div className="locked-note open">
    <div className="locked-bar"><LockOpen size={15} /><span className="grow">Open on this computer only. It locks again when you leave the note.</span>
      <button className="secondary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
      <button className="secondary" onClick={() => { if (!dirty || window.confirm('Lock without saving your changes?')) lockNow() }}><Lock size={14} />Lock</button>
      <button className="ghost" title="Remove the password" onClick={() => void removeLock()}><X size={14} />Remove lock</button>
    </div>
    <textarea className="locked-text" value={plain} spellCheck onChange={e => { setPlain(e.target.value); setDirty(true) }} />
    {error && <p className="error-text">{error}</p>}
    <p className="hint">Written as Markdown: <code># Heading</code>, <code>- item</code>, <code>- [ ] task</code>.</p>
  </div>
}

/** Asks for the new password twice before a note is locked. */
export function LockDialog({ onLock, onClose }: { onLock: (password: string) => Promise<void>; onClose: () => void }) {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const problem = a.length > 0 && a.length < 6 ? 'Use at least 6 characters.' : b && a !== b ? 'The passwords don’t match.' : ''
  async function lock() {
    setBusy(true)
    try { await onLock(a); onClose() } catch (e) { setError(errorText(e, 'Couldn’t lock it')); setBusy(false) }
  }
  return <div className="cal-modal-back" onClick={onClose}>
    <form className="card cal-modal small" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (!problem && a && a === b) void lock() }}>
      <div className="cal-modal-head"><h3><Lock size={15} /> Lock with a password</h3><button type="button" className="cal-icon" onClick={onClose}><X size={15} /></button></div>
      <p className="hint">The note’s content is encrypted on this computer before it’s saved, so it’s unreadable on both computers, in backups from now on, and to Mimir. The title stays visible. <strong>A forgotten password can’t be recovered.</strong></p>
      <label className="cal-setting">Password<input type="password" autoFocus value={a} onChange={e => setA(e.target.value)} /></label>
      <label className="cal-setting">Again<input type="password" value={b} onChange={e => setB(e.target.value)} /></label>
      {(problem || error) && <p className="error-text">{problem || error}</p>}
      <div className="actions"><button disabled={busy || !a || a !== b || !!problem}>{busy ? 'Locking…' : 'Lock the note'}</button></div>
    </form>
  </div>
}
