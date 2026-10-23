import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eraser, FileDown, Highlighter, PenLine, Plus, Redo2, Undo2, X } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { inkAppend, inkBackground, inkCompact, inkLoad, inkSetDoc, pickPdfSaveTo, studyDownloadPdf, studySavePdf } from '../../../lib/bridge'
import { errorText } from '../../../core/util'
import { compacted, eraseLine, mergeLogs, newStrokeId, readDoc, strokeLine, type InkDoc, type Paper, type Point, type Stroke, type Tool } from './model'
import { drawPaper, drawStrokes, pageSize, strokePath, touches } from './render'

const COLORS = ['#111111', '#1d4ed8', '#b91c1c', '#15803d', '#7c3aed']
const WIDTHS = [1.2, 2, 3.2]

/** Writing with a pen (a Windows pen, Apple Pencil through Sidecar, or the mouse) on pages of
 *  paper or a PDF. Every stroke is saved as it's finished; strokes from the other computer or the
 *  iPad show up when this window comes back to the front, or every few seconds. */
export function InkEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const [doc, setDoc] = useState<InkDoc | null>(null)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [backgrounds, setBackgrounds] = useState<Record<number, HTMLImageElement>>({})
  const [tool, setTool] = useState<Tool | 'eraser'>('pen')
  const [color, setColor] = useState(COLORS[0])
  const [width, setWidth] = useState(WIDTHS[1])
  const [error, setError] = useState('')
  const own = useRef<string[]>([])
  const mine = useRef<string[]>([]) // ids of strokes drawn here this time, for undo
  const redo = useRef<Stroke[]>([])
  const drawing = useRef(false)
  const penSeen = useRef(false)
  const scale = 1.5

  const reload = useCallback(async () => {
    if (drawing.current) return
    try {
      const files = await inkLoad(id)
      const d = readDoc(files.doc)
      setDoc(d)
      setStrokes(mergeLogs(files.logs))
      own.current = files.logs.find(([device]) => device === files.me)?.[1] ?? []
      for (const page of files.backgrounds) {
        if (backgrounds[page]) continue
        const url = await inkBackground(id, page)
        if (url) { const img = new Image(); img.src = url; await img.decode().catch(() => undefined); setBackgrounds(b => ({ ...b, [page]: img })) }
      }
    } catch (e) { setError(errorText(e, 'Couldn’t open the handwriting')) }
  }, [id, backgrounds])

  useEffect(() => { void reload() }, [id])
  useEffect(() => {
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    // The iPad sends strokes through the phone page as they're written.
    const stop = listen<{ id?: string }>('ink-changed', e => { if (e.payload.id === id) void reload() })
    const timer = window.setInterval(() => { if (document.hasFocus()) void reload() }, 5000)
    return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer); void stop.then(f => f()).catch(() => undefined) }
  }, [reload])

  const write = async (lines: string[]) => {
    own.current = [...own.current, ...lines]
    try { await inkAppend(id, lines) } catch (e) { setError(errorText(e, 'A stroke wasn’t saved')) }
  }

  async function finishStroke(s: Stroke) {
    setStrokes(list => [...list, s])
    mine.current.push(s.id)
    redo.current = []
    await write([strokeLine(s)])
  }

  async function erase(ids: string[]) {
    if (!ids.length) return
    setStrokes(list => list.filter(s => !ids.includes(s.id)))
    await write([eraseLine(ids)])
  }

  async function undo() {
    const last = mine.current.pop()
    const s = strokes.find(x => x.id === last)
    if (!s) return
    redo.current.push(s)
    await erase([s.id])
  }
  async function redoLast() {
    const s = redo.current.pop()
    if (!s) return
    const again = { ...s, id: newStrokeId(), t: Date.now() }
    setStrokes(list => [...list, again])
    mine.current.push(again.id)
    await write([strokeLine(again)])
  }

  async function addPage() {
    if (!doc) return
    const next = { ...doc, pages: doc.pages + 1 }
    setDoc(next)
    try { await inkSetDoc(id, JSON.stringify(next)) } catch (e) { setError(String(e)) }
  }
  async function setPaper(paper: Paper) {
    if (!doc || doc.paper === 'pdf') return
    const next = { ...doc, paper }
    setDoc(next)
    try { await inkSetDoc(id, JSON.stringify(next)) } catch (e) { setError(String(e)) }
  }

  const [exporting, setExporting] = useState(false)
  const [saved, setSaved] = useState('')
  /** The writing as a PDF: on the original's pages (saved beside it in the course), or on paper. */
  async function exportPdf() {
    if (!doc) return
    setExporting(true); setError('')
    try {
      const { annotatedPdf } = await import('./pdfInk')
      if (doc.pdf) {
        const original = await (await import('../../study/pdf')).loadBookBytes(doc.pdf.course, doc.pdf.file)
        const name = `${doc.pdf.file.replace(/\.pdf$/i, '')} (annotated)`
        const file = await studySavePdf(doc.pdf.course, name, await annotatedPdf(strokes, doc, original))
        setSaved(`Saved ${file} in ${doc.pdf.course}.`)
      } else {
        const path = await pickPdfSaveTo(`${doc.title || 'Handwritten notes'}.pdf`)
        if (path) { await studyDownloadPdf(path, await annotatedPdf(strokes, doc, null)); setSaved('Saved.') }
      }
    } catch (e) { setError(errorText(e, 'The PDF wasn’t made')) } finally { setExporting(false) }
  }

  // Tidies this device's log when it's mostly erased strokes, on the way out.
  async function close() {
    const tidy = compacted(own.current, strokes)
    if (tidy) await inkCompact(id, tidy).catch(() => undefined)
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void close()
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? redoLast() : undo()) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!doc) return <div className="ink-editor"><p className="hint">{error || 'Opening…'}</p></div>
  const [w, h] = pageSize(doc)
  return <div className="ink-editor" role="dialog" aria-label="Handwriting">
    <div className="ink-toolbar">
      <button className={tool === 'pen' ? 'on' : ''} title="Pen" onClick={() => setTool('pen')}><PenLine size={16} /></button>
      <button className={tool === 'hl' ? 'on' : ''} title="Highlighter" onClick={() => setTool('hl')}><Highlighter size={16} /></button>
      <button className={tool === 'eraser' ? 'on' : ''} title="Eraser (or the pen's eraser end)" onClick={() => setTool('eraser')}><Eraser size={16} /></button>
      <span className="ink-sep" />
      {COLORS.map(c => <button key={c} className={`ink-color${color === c ? ' on' : ''}`} style={{ background: c }} title="Colour" onClick={() => { setColor(c); if (tool === 'eraser') setTool('pen') }} />)}
      <span className="ink-sep" />
      {WIDTHS.map(x => <button key={x} className={width === x ? 'on' : ''} title="Thickness" onClick={() => setWidth(x)}><i className="ink-width" style={{ height: x * 2 }} /></button>)}
      <span className="ink-sep" />
      <button title="Undo (Ctrl+Z)" onClick={() => void undo()}><Undo2 size={16} /></button>
      <button title="Redo (Ctrl+Shift+Z)" onClick={() => void redoLast()}><Redo2 size={16} /></button>
      {doc.paper !== 'pdf' && <select value={doc.paper} onChange={e => void setPaper(e.target.value as Paper)} title="Paper">
        <option value="lines">Lined</option><option value="grid">Grid</option><option value="dots">Dots</option><option value="blank">Blank</option>
      </select>}
      <span className="grow" />
      {error && <small className="error-text">{error}</small>}
      {saved && <small className="hint">{saved}</small>}
      <button title={doc.pdf ? 'Save the PDF with your writing on it, in the course' : 'Save as a PDF'} disabled={exporting} onClick={() => void exportPdf()}><FileDown size={16} /></button>
      <button title="Done (Esc)" onClick={() => void close()}><X size={16} /></button>
    </div>
    <div className="ink-pages">
      {Array.from({ length: doc.pages }, (_, page) => <InkPage key={page} page={page} doc={doc} scale={scale} width={w} height={h}
        background={backgrounds[page]} strokes={strokes.filter(s => s.page === page)} tool={tool} color={color} penWidth={width}
        penSeen={penSeen} drawing={drawing} onStroke={s => void finishStroke(s)} onErase={ids => void erase(ids)} />)}
      {doc.paper !== 'pdf' && <button className="ink-add-page" onClick={() => void addPage()}><Plus size={14} /> Page</button>}
    </div>
  </div>
}

function InkPage({ page, doc, scale, width, height, background, strokes, tool, color, penWidth, penSeen, drawing, onStroke, onErase }: {
  page: number; doc: InkDoc; scale: number; width: number; height: number; background?: HTMLImageElement; strokes: Stroke[]
  tool: Tool | 'eraser'; color: string; penWidth: number; penSeen: React.MutableRefObject<boolean>; drawing: React.MutableRefObject<boolean>
  onStroke: (s: Stroke) => void; onErase: (ids: string[]) => void
}) {
  const base = useRef<HTMLCanvasElement>(null)
  const live = useRef<HTMLCanvasElement>(null)
  const points = useRef<Point[]>([])
  const erasing = useRef(false)
  const ratio = window.devicePixelRatio || 1
  const px = scale * ratio

  useEffect(() => {
    const ctx = base.current?.getContext('2d')
    if (!ctx) return
    drawPaper(ctx, doc, px)
    if (background) ctx.drawImage(background, 0, 0, width * px, height * px)
    drawStrokes(ctx, strokes, px)
  }, [doc, strokes, background, px, width, height])

  const at = (e: React.PointerEvent): Point => {
    const r = live.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height, p: e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5 }
  }
  const paintLive = () => {
    const ctx = live.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, live.current!.width, live.current!.height)
    if (erasing.current || !points.current.length) return
    ctx.save(); ctx.scale(px, px)
    ctx.globalAlpha = tool === 'hl' ? 0.35 : 1
    ctx.fillStyle = color
    ctx.fill(new Path2D(strokePath({ points: points.current, width: penWidth, tool: tool === 'hl' ? 'hl' : 'pen' }, true)))
    ctx.restore()
  }
  const eraseAt = (p: Point) => { const hit = strokes.filter(s => touches(s, p, 6)).map(s => s.id); if (hit.length) onErase(hit) }

  function down(e: React.PointerEvent) {
    if (e.pointerType === 'pen') penSeen.current = true
    // Palm rejection: once a pen has been used, fingers scroll instead of drawing.
    if (e.pointerType === 'touch' && penSeen.current) return
    e.preventDefault()
    live.current!.setPointerCapture(e.pointerId)
    drawing.current = true
    erasing.current = tool === 'eraser' || e.button === 5 || (e.buttons & 32) !== 0
    points.current = [at(e)]
    if (erasing.current) eraseAt(points.current[0])
  }
  function move(e: React.PointerEvent) {
    if (!drawing.current || !points.current.length) return
    const events = 'getCoalescedEvents' in e.nativeEvent ? (e.nativeEvent as PointerEvent).getCoalescedEvents() : []
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = at(ev as unknown as React.PointerEvent)
      if (erasing.current) eraseAt(p); else points.current.push(p)
    }
    paintLive()
  }
  function up() {
    if (!drawing.current) return
    drawing.current = false
    const pts = points.current
    points.current = []
    paintLive()
    if (!erasing.current && pts.length) onStroke({ id: newStrokeId(), page, t: Date.now(), tool: tool === 'hl' ? 'hl' : 'pen', color: tool === 'hl' && color === COLORS[0] ? '#facc15' : color, width: penWidth, points: pts.length === 1 ? [pts[0], { ...pts[0], x: pts[0].x + 0.1 }] : pts })
    erasing.current = false
  }

  const style = { width: width * scale, height: height * scale }
  return <div className="ink-page" style={style}>
    <canvas ref={base} width={width * px} height={height * px} style={style} />
    <canvas ref={live} width={width * px} height={height * px} style={{ ...style, touchAction: penSeen.current ? 'pan-y' : 'none' }} className="ink-live"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={e => e.preventDefault()} />
  </div>
}

/** A small picture of the first page, for the note. */
export function InkThumb({ id, onOpen }: { id: string; onOpen: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [info, setInfo] = useState<{ doc: InkDoc; strokes: Stroke[] } | null>(null)
  const load = useCallback(() => void inkLoad(id).then(f => setInfo({ doc: readDoc(f.doc), strokes: mergeLogs(f.logs) })).catch(() => undefined), [id])
  useEffect(() => { load() }, [load])
  const pages = useMemo(() => info?.doc.pages ?? 1, [info])
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !info) return
    const [w] = pageSize(info.doc)
    const s = 300 / w
    drawPaper(ctx, info.doc, s)
    drawStrokes(ctx, info.strokes.filter(x => x.page === 0), s)
  }, [info])
  const [w, h] = info ? pageSize(info.doc) : [612, 792]
  return <button className="ink-thumb" title="Write (opens the pen page)" onClick={onOpen} onFocus={load}>
    <canvas ref={canvas} width={300} height={Math.round(300 * h / w)} />
    <small>✎ Handwriting{pages > 1 ? ` · ${pages} pages` : ''}</small>
  </button>
}
