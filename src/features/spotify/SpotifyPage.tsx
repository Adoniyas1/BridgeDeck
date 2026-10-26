import { useEffect, useRef, useState } from 'react'
import { useTabAwake } from '../../core/awake'
import { ExternalLink, Globe, Laptop, Music, Pause, Play, RotateCw, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { browserGo, isTauri, openExternal, spotifyControl, spotifyOpen, spotifyStatus, type NowPlaying } from '../../lib/bridge'
import { useOverlayOpen } from '../../core/shortcuts'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { usePagePlacement } from '../browser/placement'
import { blockerChangedStore } from '../browser/state'
import PopupBar from '../browser/PopupBar'

// The web player has its own page, apart from the Browser's and TV's (src-tauri/src/browser.rs).
const PAGE = 'spotify'
const HOME = 'https://open.spotify.com/'
const MODE_KEY = 'bridgedeck.spotify.mode'
const windows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')

type Mode = 'web' | 'app'
/** The web player's page is made once and kept (switching to the app view and back keeps it playing). */
let webStarted = false

function loadMode(): Mode {
  try { const m = localStorage.getItem(MODE_KEY); if (m === 'web' || m === 'app') return m } catch { /* default */ }
  // Windows' web view can't play Spotify's protected music, so the app is the better start there.
  return windows ? 'app' : 'web'
}

const clock = (ms: number | null) => {
  if (ms == null) return '–:––'
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function SpotifyPage({ active: onScreen }: { active: boolean }) {
  const [mode, setModeState] = useState<Mode>(loadMode)
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* convenience */ } }
  return <div className="spotify">
    <div className="spotify-bar">
      <Music size={16} />
      <strong>Spotify</strong>
      <div className="spotify-modes" role="tablist">
        <button className={mode === 'web' ? 'on' : ''} onClick={() => setMode('web')}><Globe size={13} /> Web player</button>
        <button className={mode === 'app' ? 'on' : ''} onClick={() => setMode('app')}><Laptop size={13} /> Spotify app</button>
      </div>
      <span className="grow" />
      {mode === 'web' && <>
        <button className="ghost" title="Reload" onClick={() => void browserGo(PAGE, 'reload')}><RotateCw size={14} /></button>
        <button className="ghost" title="Open Spotify in your own browser" onClick={() => void openExternal(HOME)}><ExternalLink size={14} /> My browser</button>
      </>}
    </div>
    {mode === 'web' ? <WebPlayer show={onScreen} /> : <AppPlayer active={onScreen} />}
  </div>
}

function WebPlayer({ show }: { show: boolean }) {
  const overlay = useOverlayOpen()
  const blockerChanged = useStore(blockerChangedStore)
  const area = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  usePagePlacement(PAGE, show && !overlay, area, () => { if (webStarted) return null; webStarted = true; return HOME }, setError, [blockerChanged])
  return <>
    {windows && <p className="spotify-note">If songs won’t play here, Windows’ built-in web view can’t play Spotify’s protected music: use <strong>Spotify app</strong> above, or open it in your own browser.</p>}
    {error && <p className="cal-error">{error}</p>}
    <PopupBar tab={PAGE} />
    <div ref={area} className="browser-area spotify-area">{!isTauri() && <p className="hint">The web player opens here in the app.</p>}</div>
  </>
}

/** The Spotify app on this computer: what's playing, with play/pause/skip (and volume on a Mac). */
function AppPlayer({ active }: { active: boolean }) {
  const [now, setNow] = useState<NowPlaying | null>(null)
  const [at, setAt] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [volume, setVolume] = useState<number | null>(null)
  const [, tick] = useState(0)

  async function refresh() {
    if (!isTauri()) return
    try { const n = await spotifyStatus(); setNow(n); setAt(Date.now()); if (n.volume != null) setVolume(v => v ?? n.volume) } catch (e) { setError(errorText(e, 'Couldn’t reach Spotify')) }
  }
  const awake = useTabAwake()
  useEffect(() => {
    if (!awake) return
    void refresh()
    const poll = window.setInterval(() => void refresh(), 2500)
    const second = window.setInterval(() => tick(t => t + 1), 1000)
    return () => { window.clearInterval(poll); window.clearInterval(second) }
  }, [awake])

  async function act(action: 'playpause' | 'next' | 'previous' | 'volume', value?: number) {
    setBusy(true); setError('')
    try { const n = await spotifyControl(action, value); setNow(n); setAt(Date.now()) } catch (e) { setError(errorText(e, 'Spotify didn’t respond')) } finally { setBusy(false) }
  }

  if (!isTauri()) return <div className="spotify-app"><p className="hint">Controls the Spotify app when BridgeDeck runs on your computer.</p></div>
  if (now && !now.supported) return <div className="spotify-app"><p className="hint">Controlling the Spotify app works on Mac and Windows.</p></div>

  const position = now?.positionMs != null ? Math.min(now.positionMs + (now.playing ? Date.now() - at : 0), now.durationMs ?? Infinity) : null
  const progress = position != null && now?.durationMs ? (position / now.durationMs) * 100 : 0
  const nothing = now && (!now.running || !now.title)
  return <div className="spotify-app">
    <div className="spotify-card">
      <div className="spotify-art">{now?.artwork ? <img src={now.artwork} alt="" /> : <Music size={56} />}</div>
      <div className="spotify-info">
        {nothing ? <>
          <h2>{now?.running ? 'Nothing playing' : 'Spotify isn’t open'}</h2>
          <p className="hint">{now?.running ? 'Pick something in Spotify, then control it here.' : 'Open the Spotify app on this computer and play something.'}</p>
          {!now?.running && <div className="actions"><button onClick={() => void spotifyOpen().then(() => window.setTimeout(() => void refresh(), 2500)).catch(e => setError(errorText(e, 'Couldn’t open Spotify')))}><Play size={14} /> Open Spotify</button></div>}
        </> : now ? <>
          <h2 title={now.title}>{now.title}</h2>
          <p className="spotify-artist">{[now.artist, now.album].filter(Boolean).join(' · ')}</p>
          <div className="spotify-progress"><span>{clock(position)}</span><div className="spotify-track"><i style={{ width: `${progress}%` }} /></div><span>{clock(now.durationMs)}</span></div>
          <div className="spotify-controls">
            <button className="spotify-skip" title="Previous" disabled={busy} onClick={() => void act('previous')}><SkipBack size={20} /></button>
            <button className="spotify-play" title={now.playing ? 'Pause' : 'Play'} disabled={busy} onClick={() => void act('playpause')}>{now.playing ? <Pause size={24} /> : <Play size={24} />}</button>
            <button className="spotify-skip" title="Next" disabled={busy} onClick={() => void act('next')}><SkipForward size={20} /></button>
          </div>
          {now.volume != null && <label className="spotify-volume"><Volume2 size={15} /><input type="range" min={0} max={100} value={volume ?? now.volume} onChange={e => setVolume(Number(e.target.value))} onPointerUp={() => volume != null && void act('volume', volume)} onKeyUp={() => volume != null && void act('volume', volume)} /></label>}
        </> : <p className="hint">Looking for Spotify…</p>}
        {(error || now?.error) && <p className="error-text">{error || now?.error}</p>}
      </div>
    </div>
    <p className="hint spotify-foot">This controls the Spotify app on this computer.{windows ? ' On Windows it uses the system’s media controls; change the volume in Spotify.' : ' The first time, macOS asks to let BridgeDeck control Spotify.'}</p>
  </div>
}
