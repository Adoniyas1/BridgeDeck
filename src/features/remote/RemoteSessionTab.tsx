import { useEffect, useRef, useState } from 'react'
import { Channel } from '@tauri-apps/api/core'
import { Expand, Monitor, Power, RefreshCw } from 'lucide-react'
import { remoteConnect, remoteDisconnect, remoteFrameDrawn, remoteInput, remoteSettings } from '../../lib/bridge'
import type { DynamicTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import { buttonName, keyName, parsePacket, wheelPixels, type InputEvent } from './keys'

type Ready = { monitors: Array<{ index: number; name: string; width: number; height: number; primary: boolean }>; monitor: number; hostName: string; platform: string }
const QUALITY = { high: 85, auto: 70, low: 45 } as const
const viewerIsMac = /Mac/i.test(navigator.platform || navigator.userAgent)

/** Another device's screen in a tab: frames drawn on a canvas, mouse and keyboard sent back. */
export default function RemoteSessionTab({ tab, active }: { tab: DynamicTab; active: boolean }) {
  const peer = String(tab.params?.peer ?? '')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const session = useRef('')
  const activeRef = useRef(active)
  const owedDraw = useRef(false)
  const pressed = useRef(new Set<string>())
  const pending = useRef<InputEvent[]>([])
  const stats = useRef({ frames: 0, bytes: 0, since: performance.now() })
  const [state, setState] = useState<'connecting' | 'live' | 'ended'>('connecting')
  const [detail, setDetail] = useState('')
  const [ready, setReady] = useState<Ready | null>(null)
  const [monitor, setMonitor] = useState(0)
  const [quality, setQuality] = useState<keyof typeof QUALITY>('auto')
  const [swapCommand, setSwapCommand] = useState(true)
  const [rate, setRate] = useState('')
  const [attempt, setAttempt] = useState(0)

  // A hidden tab doesn't draw, so it stops asking for frames; showing it again resumes.
  useEffect(() => {
    activeRef.current = active
    if (active && owedDraw.current && session.current) {
      owedDraw.current = false
      void remoteFrameDrawn(session.current).catch(() => undefined)
    }
  }, [active])

  useEffect(() => {
    let closed = false
    const channel = new Channel<ArrayBuffer>()
    channel.onmessage = data => void onPacket(data)
    const maxWidth = Math.min(3840, Math.max(960, Math.round(window.screen.width * (window.devicePixelRatio || 1))))
    setState('connecting')
    setDetail('')
    remoteConnect(peer, 0, maxWidth, QUALITY.auto, channel)
      .then(id => { if (closed) void remoteDisconnect(id); else { session.current = id; setState('live') } })
      .catch(error => { if (!closed) { setState('ended'); setDetail(errorText(error, 'Could not connect')) } })
    const timer = window.setInterval(() => {
      const s = stats.current
      const seconds = (performance.now() - s.since) / 1000
      setRate(s.frames ? `${Math.round(s.frames / seconds)} fps · ${Math.round((s.bytes * 8) / seconds / 1000)} kbit/s` : '')
      stats.current = { frames: 0, bytes: 0, since: performance.now() }
    }, 2000)
    return () => {
      closed = true
      window.clearInterval(timer)
      if (session.current) void remoteDisconnect(session.current).catch(() => undefined)
      session.current = ''
    }
  }, [peer, attempt])

  async function onPacket(data: ArrayBuffer) {
    const packet = parsePacket(data)
    if (packet.kind === 'event') {
      if (packet.event.type === 'ready') { setReady(packet.event.ready); setMonitor(packet.event.ready.monitor) }
      if (packet.event.type === 'ended') { setState('ended'); setDetail(packet.event.reason); session.current = '' }
      return
    }
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (canvas && context && packet.header.tiles.length) {
      if (canvas.width !== packet.header.width || canvas.height !== packet.header.height) {
        canvas.width = packet.header.width
        canvas.height = packet.header.height
      }
      let offset = 0
      const bitmaps = await Promise.all(packet.header.tiles.map(tile => {
        const bytes = packet.payload.slice(offset, offset + tile.len)
        offset += tile.len
        return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).catch(() => null)
      }))
      bitmaps.forEach((bitmap, i) => {
        if (!bitmap) return
        const tile = packet.header.tiles[i]
        context.drawImage(bitmap, tile.x, tile.y)
        bitmap.close()
      })
      stats.current.frames += 1
    }
    stats.current.bytes += packet.header.bytes
    if (!session.current) return
    if (activeRef.current) void remoteFrameDrawn(session.current).catch(() => undefined)
    else owedDraw.current = true
  }

  // Input: batched per animation frame, mouse moves coalesced to the latest position.
  function send(event: InputEvent) {
    if (!session.current) return
    const queue = pending.current
    if (event.t === 'move' && queue.length && queue[queue.length - 1].t === 'move') queue[queue.length - 1] = event
    else queue.push(event)
    if (queue.length === 1) requestAnimationFrame(() => {
      const events = pending.current
      pending.current = []
      if (events.length && session.current) void remoteInput(session.current, events).catch(() => undefined)
    })
  }

  const position = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { t: 'move' as const, x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
  }

  function key(e: React.KeyboardEvent, down: boolean) {
    e.preventDefault()
    const name = keyName(e.nativeEvent, { hostIsMac: ready?.platform === 'macos', viewerIsMac, swapCommand })
    if (!name) return
    if (down) pressed.current.add(name); else pressed.current.delete(name)
    send({ t: 'key', key: name, down })
  }

  // Leaving the canvas mid-shortcut must not leave a key held down on the other computer.
  function releaseAll() {
    pressed.current.forEach(name => send({ t: 'key', key: name, down: false }))
    pressed.current.clear()
  }

  function change(changes: { monitor?: number; quality?: number }) {
    if (session.current) void remoteSettings(session.current, changes).catch(() => undefined)
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Wheel needs a non-passive listener to stop the page from scrolling.
    const onWheel = (e: WheelEvent) => { e.preventDefault(); send({ t: 'wheel', ...wheelPixels(e) }) }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  return <div className="remote-session">
    <div className="remote-toolbar">
      <strong>{ready?.hostName || String(tab.params?.name ?? 'Remote')}</strong>
      <span className={`remote-state ${state}`}>{state === 'live' ? rate || 'Connected' : state === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
      {ready && ready.monitors.length > 1 && <label><Monitor size={14}/><select value={monitor} onChange={e => { const m = Number(e.target.value); setMonitor(m); change({ monitor: m }) }}>{ready.monitors.map(m => <option key={m.index} value={m.index}>{m.name}{m.primary ? ' (main)' : ''}</option>)}</select></label>}
      <label>Quality<select value={quality} onChange={e => { const q = e.target.value as keyof typeof QUALITY; setQuality(q); change({ quality: QUALITY[q] }) }}><option value="high">High</option><option value="auto">Normal</option><option value="low">Low (slow networks)</option></select></label>
      {ready && (ready.platform === 'macos') !== viewerIsMac && <label title="Ctrl here acts as Command on a Mac (and the reverse)"><input type="checkbox" checked={swapCommand} onChange={e => setSwapCommand(e.target.checked)}/>{viewerIsMac ? 'Cmd → Ctrl' : 'Ctrl → Cmd'}</label>}
      <span className="grow"/>
      <button className="ghost" title="Full screen" onClick={() => void canvasRef.current?.parentElement?.requestFullscreen().catch(() => undefined)}><Expand size={15}/></button>
      {state === 'ended'
        ? <button className="ghost" onClick={() => setAttempt(a => a + 1)}><RefreshCw size={15}/>Reconnect</button>
        : <button className="ghost" title="Disconnect" onClick={() => { if (session.current) void remoteDisconnect(session.current); session.current = ''; setState('ended'); setDetail('Disconnected') }}><Power size={15}/></button>}
    </div>
    <div className="remote-screen">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        width={1280}
        height={720}
        onMouseMove={e => send(position(e))}
        onMouseDown={e => { e.currentTarget.focus(); send(position(e)); send({ t: 'button', button: buttonName(e.button), down: true }) }}
        onMouseUp={e => send({ t: 'button', button: buttonName(e.button), down: false })}
        onContextMenu={e => e.preventDefault()}
        onKeyDown={e => key(e, true)}
        onKeyUp={e => key(e, false)}
        onBlur={releaseAll}
      />
      {state !== 'live' && <div className="remote-overlay">{state === 'connecting' ? 'Connecting…' : detail || 'Disconnected'}</div>}
    </div>
  </div>
}
