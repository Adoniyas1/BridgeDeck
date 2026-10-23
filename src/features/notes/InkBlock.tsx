import { lazy, Suspense, useEffect, useState } from 'react'
import { createStore, useStore } from '../../core/store'

// The pen editor (and perfect-freehand) load only when handwriting is opened.
const InkEditor = lazy(() => import('./ink/InkEditor').then(m => ({ default: m.InkEditor })))
const InkThumb = lazy(() => import('./ink/InkEditor').then(m => ({ default: m.InkThumb })))

/** Opens the pen page for a handwriting block (set when one is made). */
export const inkOpenRequest = createStore<string | null>(null)

/** A handwriting block: a picture of its first page; clicking it opens the pen page. */
export function InkBlock({ id }: { id: string }) {
  const request = useStore(inkOpenRequest)
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState(0)
  useEffect(() => { if (request === id) { setOpen(true); inkOpenRequest.set(null) } }, [request, id])
  return <Suspense fallback={<p className="hint">✎ Handwriting</p>}>
    <InkThumb key={version} id={id} onOpen={() => setOpen(true)} />
    {open && <InkEditor id={id} onClose={() => { setOpen(false); setVersion(v => v + 1) }} />}
  </Suspense>
}
