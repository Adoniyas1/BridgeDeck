import { useEffect, useRef, useState } from 'react'
import { Check, RotateCcw, Wand2, X } from 'lucide-react'
import { defaultCorners, outputSize, type Pt } from './warp'

/** Marking a page's four corners on a photo, then a flat, white copy of it to keep. */
export function ScanCrop({ src, onDone, onCancel }: { src: string; onDone: (jpeg: Blob) => void; onCancel: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [corners, setCorners] = useState<Pt[]>([])
  const [white, setWhite] = useState(true)
  const [result, setResult] = useState<{ url: string; blob: Blob } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)

  useEffect(() => {
    const image = new Image()
    // Served with CORS by the bdbook scheme, so its pixels can be read.
    image.crossOrigin = 'anonymous'
    image.onload = () => { setImg(image); setCorners(defaultCorners(image.naturalWidth, image.naturalHeight)) }
    image.onerror = () => setError(/\.heic($|\?)/i.test(src) ? 'This computer can’t open HEIC photos. On the iPhone, set Camera → Formats → Most Compatible, or send it from the phone page (which sends JPEG).' : 'The photo couldn’t be opened.')
    image.src = src
  }, [src])

  const toImage = (e: React.PointerEvent): Pt => {
    const r = box.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(img!.naturalWidth, ((e.clientX - r.left) / r.width) * img!.naturalWidth)), y: Math.max(0, Math.min(img!.naturalHeight, ((e.clientY - r.top) / r.height) * img!.naturalHeight)) }
  }

  async function straighten() {
    if (!img) return
    setBusy(true); setError('')
    try {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const source = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const out = outputSize(corners)
      const worker = new Worker(new URL('./warp.worker.ts', import.meta.url), { type: 'module' })
      const done = await new Promise<{ data: Uint8ClampedArray; width: number; height: number }>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<{ data?: Uint8ClampedArray; width: number; height: number; error?: string }>) => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data as { data: Uint8ClampedArray; width: number; height: number })
        worker.onerror = e => reject(new Error(e.message))
        worker.postMessage({ data: source.data, width: source.width, height: source.height, corners, out, whiten: white }, [source.data.buffer])
      }).finally(() => worker.terminate())
      const page = document.createElement('canvas')
      page.width = done.width; page.height = done.height
      page.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(done.data), done.width, done.height), 0, 0)
      const blob = await new Promise<Blob | null>(resolve => page.toBlob(resolve, 'image/jpeg', 0.88))
      if (!blob) throw new Error('The page couldn’t be made')
      if (result) URL.revokeObjectURL(result.url)
      setResult({ url: URL.createObjectURL(blob), blob })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const pct = (p: Pt) => img ? { left: `${(p.x / img.naturalWidth) * 100}%`, top: `${(p.y / img.naturalHeight) * 100}%` } : {}
  return <div className="scan-crop" role="dialog" aria-label="Straighten the page">
    <div className="scan-crop-bar">
      <strong className="grow">{result ? 'The straightened page' : 'Drag the four dots to the page’s corners'}</strong>
      {!result && <label><input type="checkbox" checked={white} onChange={e => setWhite(e.target.checked)} /> Whiten paper</label>}
      {result ? <>
        <button className="ghost" onClick={() => setResult(null)}><RotateCcw size={14} />Adjust</button>
        <button onClick={() => onDone(result.blob)}><Check size={14} />Keep it</button>
      </> : <button disabled={!img || busy} onClick={() => void straighten()}><Wand2 size={14} />{busy ? 'Working…' : 'Straighten'}</button>}
      <button className="ghost" title="Cancel" onClick={onCancel}><X size={14} /></button>
    </div>
    {error && <p className="error-text">{error}</p>}
    <div className="scan-crop-view">
      {result ? <img src={result.url} alt="The straightened page" /> : img && <div ref={box} className="scan-crop-box"
        onPointerMove={e => { if (dragging.current !== null) { const p = toImage(e); setCorners(c => c.map((q, i) => i === dragging.current ? p : q)) } }}
        onPointerUp={() => { dragging.current = null }}>
        <img src={src} alt="The photo" crossOrigin="anonymous" draggable={false} />
        <svg viewBox={`0 0 ${img.naturalWidth} ${img.naturalHeight}`} preserveAspectRatio="none"><polygon points={corners.map(c => `${c.x},${c.y}`).join(' ')} /></svg>
        {corners.map((c, i) => <span key={i} className="scan-handle" style={pct(c)} onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); dragging.current = i }} />)}
      </div>}
    </div>
  </div>
}
