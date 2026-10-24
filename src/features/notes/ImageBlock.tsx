import { useEffect, useState } from 'react'
import { noteImageLoad } from '../../lib/bridge'

/** A picture in a note (an image block: its text is the picture's id). It may still be syncing
 *  from the other computer, so it's looked for again when the window comes back to the front. */
export function ImageBlock({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const load = () => void noteImageLoad(id).then(u => { if (live) setUrl(u) }).catch(() => { if (live) setUrl(null) })
    load()
    window.addEventListener('focus', load)
    return () => { live = false; window.removeEventListener('focus', load) }
  }, [id])
  if (url === undefined) return <p className="notes-other">🖼 Loading the picture…</p>
  if (url === null) return <p className="notes-other">🖼 This picture hasn’t synced to this computer yet.</p>
  return <img className="notes-image" src={url} alt="A picture in the note" />
}
