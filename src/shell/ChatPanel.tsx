import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { BookmarkCheck, BookmarkPlus, MessageCircleQuestion, SquarePen, X } from 'lucide-react'
import { useStore } from '../core/store'
import { chatPanelStore, PANEL_MIN, saveWidth } from '../core/chatgpt'
import { useOverlayOpen } from '../core/shortcuts'
import { chatgptHide, chatgptNew, chatgptSave, chatgptShow, isTauri } from '../lib/bridge'

/** ChatGPT at the side of the window, like a browser's assistant panel. The page itself is a
 *  native web view laid over the panel's body (src-tauri/src/chatgpt.rs); the rest of BridgeDeck
 *  narrows to make room. Its header is as tall as the page toolbars, so ChatGPT starts on the same line as the
 *  page beside it; the tab bar's ChatGPT button opens and closes it, and dragging its left edge resizes it. */
export default function ChatPanel() {
  const { open, width, ask } = useStore(chatPanelStore)
  const body = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const sent = useRef(0)
  const overlay = useOverlayOpen()
  // "Save to BridgeDeck": idle, saving, or how the last save went (shown for a moment).
  const [saving, setSaving] = useState<{ state: 'idle' | 'saving' | 'done' | 'failed'; message: string }>({ state: 'idle', message: '' })
  const resetTimer = useRef<number>()

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let closed = false
    void listen<{ ok: boolean; message: string }>('chatgpt-saved', e => {
      setSaving({ state: e.payload.ok ? 'done' : 'failed', message: e.payload.message })
      window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setSaving({ state: 'idle', message: '' }), e.payload.ok ? 2500 : 5000)
    }).then(fn => { if (closed) fn(); else unlisten = fn })
    return () => { closed = true; unlisten?.(); window.clearTimeout(resetTimer.current) }
  }, [])

  function save() {
    setSaving({ state: 'saving', message: '' })
    void chatgptSave().catch(e => setSaving({ state: 'failed', message: String(e) }))
    // No answer (the page didn't respond): back to normal.
    window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setSaving({ state: 'idle', message: '' }), 8000)
  }

  useEffect(() => {
    const el = body.current
    if (!isTauri()) return
    if (!open || dragging || overlay || !el) { void chatgptHide().catch(() => undefined); return }
    let last = ''
    const place = () => {
      const r = el.getBoundingClientRect()
      const fresh = ask && ask.at !== sent.current ? ask : null
      const at = [r.left, r.top, r.width, r.height].map(Math.round).join(',')
      if (at === last && !fresh) return
      last = at
      if (fresh) sent.current = fresh.at
      void chatgptShow(fresh?.text ?? null, fresh?.folder ?? null, r.left, r.top, r.width, r.height).then(() => setError('')).catch(e => setError(String(e)))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    const timer = window.setInterval(place, 400)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.clearInterval(timer) }
  }, [open, dragging, overlay, ask])

  // Hidden while the window is closed to the tray or the panel is closed.
  useEffect(() => () => { void chatgptHide().catch(() => undefined) }, [])

  function startDrag(e: React.PointerEvent) {
    e.preventDefault()
    setDragging(true)
    const move = (ev: PointerEvent) => {
      const next = Math.min(Math.max(PANEL_MIN, window.innerWidth - ev.clientX), Math.round(window.innerWidth * 0.7))
      chatPanelStore.set(s => ({ ...s, width: next }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      saveWidth(chatPanelStore.get().width)
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!open) return null
  return <aside className="chat-panel" style={{ width }}>
    <div className="chat-panel-edge" onPointerDown={startDrag} title="Drag to resize" />
    <header className="chat-panel-head">
      <MessageCircleQuestion size={15} /><strong>ChatGPT</strong>
      <span className="grow" />
      <button className={`chat-panel-save ${saving.state}`} disabled={saving.state === 'saving' || !isTauri()} onClick={save}
        title={saving.state === 'failed' ? saving.message : 'Keep this chat as a note in BridgeDeck (saving again updates it)'}>
        {saving.state === 'done' ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}
        <span>{saving.state === 'saving' ? 'Saving…' : saving.state === 'done' ? 'Saved' : saving.state === 'failed' ? saving.message : 'Save to BridgeDeck'}</span>
      </button>
      <button className="cal-icon" title="New chat" onClick={() => void chatgptNew().catch(() => undefined)}><SquarePen size={15} /></button>
      <button className="cal-icon" title="Close (the chat stays for next time)" onClick={() => chatPanelStore.set(s => ({ ...s, open: false }))}><X size={15} /></button>
    </header>
    {error && <p className="cal-error chat-panel-error">{error}</p>}
    <div ref={body} className="chat-panel-body">
      {(!isTauri() || dragging) && <p className="hint">{dragging ? 'Resizing…' : 'ChatGPT opens here in the BridgeDeck app.'}</p>}
    </div>
  </aside>
}
