import { lazy, Suspense, useEffect, useState } from 'react'
import { PenTool } from 'lucide-react'
import { drawingLoad, isTauri } from '../../lib/bridge'

const DrawingEditor = lazy(() => import('./DrawingEditor'))

/** A drawing in a note: its picture, and a click to draw (Excalidraw, full window). */
export function DrawingBlock({ id }: { id: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [scene, setScene] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isTauri()) return
    void drawingLoad(id).then(d => { setSvg(d.svg); setScene(d.scene) }).catch(e => setError(String(e)))
  }, [id])

  return <div className="notes-drawing">
    <button className="notes-drawing-view" title="Draw" onClick={() => setEditing(true)}>
      {svg ? <img alt="Drawing" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} /> : <span className="hint"><PenTool size={15} /> Empty drawing. Click to draw.</span>}
    </button>
    {error && <p className="error-text">{error}</p>}
    {editing && <Suspense fallback={<div className="drawing-editor"><p className="hint">Opening the drawing…</p></div>}>
      <DrawingEditor id={id} scene={scene} onClose={saved => { setEditing(false); if (saved) { setSvg(saved.svg); setScene(saved.scene) } }} />
    </Suspense>}
  </div>
}
