import { useEffect, useMemo, useState } from 'react'
import katex from 'katex'
import { Check, Sparkles, X } from 'lucide-react'
import { notesCreateMarkdown } from '../../lib/bridge'
import { aiAllowed } from '../../core/exam'
import { errorText } from '../../core/util'
import { notesStore } from '../notes/state'
import { askMimir } from '../mimir'
import { badMathLines, doubtfulLines, handwritingPrompt } from './handwriting'
import { courseFolder } from './model'
import { recogniseImage, stopRecognition } from './ocr'

const typesets = (tex: string, display: boolean) => { try { katex.renderToString(tex, { throwOnError: true, displayMode: display }); return true } catch { return false } }

/** A photo of handwritten notes beside what was read from it, to correct before it becomes a note.
 *  Text recognition here reads print best; Mimir (with a model that reads pictures) reads
 *  handwriting and math much better, and saves its own note. */
export function ScanReview({ course, file, src, onClose, onStatus }: { course: string; file: string; src: string; onClose: () => void; onStatus: (s: string) => void }) {
  const [text, setText] = useState('')
  const [reading, setReading] = useState(true)
  useEffect(() => {
    let live = true
    void recogniseImage(src).then(t => { if (live) setText(t.trim()) }).catch(e => { if (live) onStatus(`The text couldn’t be read here: ${errorText(e, 'unknown error')}`) }).finally(() => { if (live) setReading(false); void stopRecognition() })
    return () => { live = false }
  }, [src])
  const flagged = useMemo(() => new Set([...badMathLines(text, typesets), ...doubtfulLines(text)]), [text])

  async function save() {
    try {
      const note = await notesCreateMarkdown(`${file.replace(/\.[^.]+$/, '')} — notes`, courseFolder(course), 'note', `${text.trim()}\n\n*Read from the photo ${file} in the ${course} folder.*`)
      notesStore.set(list => [note, ...list])
      onStatus('Saved the notes.')
      onClose()
    } catch (e) { onStatus(errorText(e, 'Couldn’t save it')) }
  }

  return <div className="scan-review" role="dialog" aria-label="Check the read notes">
    <div className="scan-crop-bar">
      <strong className="grow">Check what was read</strong>
      {aiAllowed(course) && <button className="ghost" title="Mimir reads the handwriting and math with its own model and saves a note" onClick={() => { void askMimir(handwritingPrompt(course, file, courseFolder(course)), true, course); onClose() }}><Sparkles size={14} />Read it with Mimir instead</button>}
      <button disabled={!text.trim()} onClick={() => void save()}><Check size={14} />Save as a note</button>
      <button className="ghost" title="Close" onClick={onClose}><X size={14} /></button>
    </div>
    <div className="scan-review-panes">
      <div className="scan-review-photo"><img src={src} alt={file} /></div>
      <div className="scan-review-text">
        <textarea value={text} placeholder={reading ? 'Reading…' : 'Nothing was read. Type it, or ask Mimir.'} onChange={e => setText(e.target.value)} spellCheck />
        {flagged.size > 0 && <p className="hint">Check line{flagged.size === 1 ? '' : 's'} {[...flagged].sort((a, b) => a - b).map(i => i + 1).join(', ')}: {[...flagged].some(i => badMathLines(text.split('\n')[i] ?? '', typesets).length) ? 'math that doesn’t typeset, or ' : ''}words that look misread.</p>}
        <p className="hint">Math as $…$ or $$…$$ (LaTeX) shows typeset in the note.</p>
      </div>
    </div>
  </div>
}
