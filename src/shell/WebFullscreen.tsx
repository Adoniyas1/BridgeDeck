import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '../lib/bridge'

/** Windows: a video player in a web page went full screen (src-tauri/src/webmedia.rs made the window
 *  full screen); BridgeDeck's bars are hidden so the page fills it, and come back when it ends.
 *  (On a Mac, WebKit takes the video to full screen itself.) */
export default function WebFullscreen() {
  useEffect(() => {
    if (!isTauri()) return
    const stop = listen<{ label: string; on: boolean }>('web-fullscreen', e => document.body.classList.toggle('web-full', e.payload.on))
    return () => { void stop.then(f => f()).catch(() => undefined); document.body.classList.remove('web-full') }
  }, [])
  return null
}
