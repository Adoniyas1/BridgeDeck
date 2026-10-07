import { useEffect, useState } from 'react'
import { Music, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { isTauri, spotifyControl, spotifyStatus, type NowPlaying } from '../../lib/bridge'
import { activateTab } from '../../core/tabs'

const desktop = typeof navigator !== 'undefined' && /Mac|Windows/.test(navigator.userAgent)

/** In the tab bar while the Spotify app plays something: the song, and previous / play-pause /
 *  next, from any tab. Checks every 8 seconds while BridgeDeck is on screen. */
export function SpotifyMini() {
  const [now, setNow] = useState<NowPlaying | null>(null)
  useEffect(() => {
    if (!isTauri() || !desktop) return
    let stopped = false
    const check = () => { if (document.visibilityState === 'visible') void spotifyStatus().then(n => { if (!stopped) setNow(n) }).catch(() => undefined) }
    check()
    const timer = window.setInterval(check, 8000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [])
  if (!now?.running || !now.title) return null
  const act = (action: 'playpause' | 'next' | 'previous') => void spotifyControl(action).then(setNow).catch(() => undefined)
  return <div className="spotify-mini">
    <button className="spotify-mini-song" title={`${now.title} · ${now.artist}\nOpen the Spotify tab`} onClick={() => activateTab('spotify')}>
      {now.artwork ? <img src={now.artwork} alt="" /> : <Music size={13} />}<span>{now.title}</span>
    </button>
    <button title="Previous" onClick={() => act('previous')}><SkipBack size={13} /></button>
    <button title={now.playing ? 'Pause' : 'Play'} onClick={() => act('playpause')}>{now.playing ? <Pause size={13} /> : <Play size={13} />}</button>
    <button title="Next" onClick={() => act('next')}><SkipForward size={13} /></button>
  </div>
}
