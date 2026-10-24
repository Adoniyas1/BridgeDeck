import { useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import { Check, ImagePlus, Sparkles, X } from 'lucide-react'
import { handwritingVision, noteImageSave, notesCreateMarkdown, studyPatchCourseInfo } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { configStore, useConfig } from '../../core/config'
import { libraryStore, refreshLibrary } from './state'
import { aiAllowed } from '../../core/exam'
import { errorText } from '../../core/util'
import { notesStore } from '../notes/state'
import { newId } from '../notes/model'
import { askMimir } from '../mimir'
import { badMathLines, corrections, doubtfulLines, handwritingPrompt, mergeFixes } from './handwriting'
import { wordFixes } from './lecture'
import { courseFolder } from './model'
import { recogniseImage, stopRecognition } from './ocr'

const typesets = (tex: string, display: boolean) => { try { katex.renderToString(tex, { throwOnError: true, displayMode: display }); return true } catch { return false } }

/** A photo of handwritten notes beside what was read from it, to correct before it becomes a note.
 *  Text recognition here reads print best; Mimir (with a model that reads pictures) reads
 *  handwriting and math much better, and saves its own note. */
export function ScanReview({ course, file, src, onClose, onStatus }: { course: string; file: string; src: string; onClose: () => void; onStatus: (s: string) => void }) {
  const [text, setText] = useState('')
  /** What was read, before any fixing by hand: the fixes are kept for the next photo. */
  const [read, setRead] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const [figure, setFigure] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const dragging = useRef(false)
  const [reading, setReading] = useState(true)
  const [unsure, setUnsure] = useState<number[]>([])
  const info = useStore(libraryStore).library?.courses.find(c => c.name === course)?.info
  const config = useConfig()
  const reader = config.study.handwritingReader ?? 'auto'
  const setReader = (r: 'auto' | 'text' | 'mimir') => configStore.set(c => ({ ...c, study: { ...c.study, handwritingReader: r === 'auto' ? undefined : r } }))
  const toMimir = () => { void askMimir(handwritingPrompt(course, file, courseFolder(course)), true, course); onClose() }
  useEffect(() => {
    if (reader === 'mimir' && aiAllowed(course)) { toMimir(); return }
    let live = true
    // On the Mac, Apple's Vision reads handwriting far better than text recognition in the window.
    const fixes = wordFixes(info?.handwriting)
    const words = [...(Array.isArray(info?.words) ? info!.words as string[] : []), ...(Array.isArray(info?.handwriting) ? info!.handwriting as string[] : [])].map(w => w.split('=>').pop()!.trim()).filter(Boolean)
    const vision = (reader === 'text' ? Promise.reject(new Error('text recognition chosen')) : handwritingVision(course, file, words)).then(lines => {
      setUnsure(lines.flatMap((l, i) => l.confidence < 0.5 ? [i] : []))
      return lines.map(l => l.text).join('\n')
    })
    void vision.catch(() => recogniseImage(src)).then(t => {
      if (!live) return
      // Words fixed by hand on earlier photos of this course are fixed here already.
      const fixed = fixes.reduce((out, f) => out.replace(f.heard, f.written), t.trim())
      setText(fixed); setRead(fixed)
    }).catch(e => { if (live) onStatus(`The text couldn’t be read here: ${errorText(e, 'unknown error')}`) }).finally(() => { if (live) setReading(false); void stopRecognition() })
    return () => { live = false }
  }, [src, reader])
  const flagged = useMemo(() => new Set([...badMathLines(text, typesets), ...doubtfulLines(text), ...unsure]), [text, unsure])

  async function save() {
    try {
      const note = await notesCreateMarkdown(`${file.replace(/\.[^.]+$/, '')} — notes`, courseFolder(course), 'note', `${text.trim()}\n\n*Read from the photo ${file} in the ${course} folder.*`)
      notesStore.set(list => [note, ...list])
      const fresh = corrections(read, text)
      if (fresh.length) await studyPatchCourseInfo(course, { handwriting: mergeFixes(info?.handwriting, fresh) }).then(refreshLibrary).catch(() => undefined)
      onStatus(`Saved the notes.${fresh.length ? ` ${fresh.length} fix${fresh.length === 1 ? '' : 'es'} kept for the next photo.` : ''}`)
      onClose()
    } catch (e) { onStatus(errorText(e, 'Couldn’t save it')) }
  }

  // A box dragged round a drawing on the photo becomes a picture in the note, where the cursor is.
  const at = (e: React.PointerEvent) => { const r = box.current!.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) } }
  async function addFigure() {
    if (!figure) return
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = src
      await img.decode()
      const [x, y] = [Math.min(figure.x0, figure.x1) * img.naturalWidth, Math.min(figure.y0, figure.y1) * img.naturalHeight]
      const [w, h] = [Math.abs(figure.x1 - figure.x0) * img.naturalWidth, Math.abs(figure.y1 - figure.y0) * img.naturalHeight]
      const k = Math.min(1, 1600 / Math.max(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w * k)); canvas.height = Math.max(1, Math.round(h * k))
      canvas.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9))
      if (!blob) throw new Error('The figure couldn’t be cut out')
      const id = newId()
      await noteImageSave(id, new Uint8Array(await blob.arrayBuffer()))
      const pos = area.current?.selectionStart ?? text.length
      const before = text.slice(0, pos), after = text.slice(pos)
      setText(`${before}${before && !before.endsWith('\n') ? '\n' : ''}![Image](bridgedeck-image:${id})\n${after}`)
      setFigure(null)
    } catch (e) { onStatus(errorText(e, 'Couldn’t add the figure')) }
  }

  return <div className="scan-review" role="dialog" aria-label="Check the read notes">
    <div className="scan-crop-bar">
      <strong className="grow">Check what was read</strong>
      <select value={reader} title="What reads the photo first (remembered)" onChange={e => setReader(e.target.value as 'auto' | 'text' | 'mimir')}>
        <option value="auto">Read with: Apple Vision (Mac), else text recognition</option>
        <option value="text">Read with: text recognition</option>
        {aiAllowed(course) && <option value="mimir">Read with: Mimir (its vision model)</option>}
      </select>
      {aiAllowed(course) && reader !== 'mimir' && <button className="ghost" title="Mimir reads the handwriting and math with its own model and saves a note" onClick={toMimir}><Sparkles size={14} />Read it with Mimir instead</button>}
      {figure && Math.abs(figure.x1 - figure.x0) > 0.02 && Math.abs(figure.y1 - figure.y0) > 0.02 && !dragging.current && <button className="ghost" title="Put the boxed part of the photo in the note, where the cursor is" onClick={() => void addFigure()}><ImagePlus size={14} />Add the figure</button>}
      <button disabled={!text.trim()} onClick={() => void save()}><Check size={14} />Save as a note</button>
      <button className="ghost" title="Close" onClick={onClose}><X size={14} /></button>
    </div>
    <div className="scan-review-panes">
      <div className="scan-review-photo"><div ref={box} className="scan-review-box" title="Drag a box round a drawing to put it in the note"
        onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); dragging.current = true; const p = at(e); setFigure({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }) }}
        onPointerMove={e => { if (dragging.current) { const p = at(e); setFigure(f => f && { ...f, x1: p.x, y1: p.y }) } }}
        onPointerUp={() => { dragging.current = false; setFigure(f => f && { ...f }) }}>
        <img src={src} alt={file} crossOrigin="anonymous" draggable={false} />
        {figure && <span className="scan-figure" style={{ left: `${Math.min(figure.x0, figure.x1) * 100}%`, top: `${Math.min(figure.y0, figure.y1) * 100}%`, width: `${Math.abs(figure.x1 - figure.x0) * 100}%`, height: `${Math.abs(figure.y1 - figure.y0) * 100}%` }} />}
      </div></div>
      <div className="scan-review-text">
        <textarea ref={area} value={text} placeholder={reading ? 'Reading…' : 'Nothing was read. Type it, or ask Mimir.'} onChange={e => setText(e.target.value)} spellCheck />
        {flagged.size > 0 && <p className="hint">Check line{flagged.size === 1 ? '' : 's'} {[...flagged].sort((a, b) => a - b).map(i => i + 1).join(', ')}: {[...flagged].some(i => badMathLines(text.split('\n')[i] ?? '', typesets).length) ? 'math that doesn’t typeset, or ' : ''}words that look misread.</p>}
        <p className="hint">Math as $…$ or $$…$$ (LaTeX) shows typeset in the note. Drag a box round a drawing on the photo to put it in. Words you fix are fixed by themselves on the next photo.</p>
      </div>
    </div>
  </div>
}
