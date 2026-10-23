import { useState } from 'react'
import { FileType } from 'lucide-react'
import { isTauri, pickPdfSaveTo, studyDownloadPdf, studySavePdf, typstPdf, type Note } from '../../lib/bridge'
import { setNotice } from '../../core/notice'
import { errorText } from '../../core/util'
import { noteTitle } from './model'
import { noteTypst, withoutMitex, type TypstStyle } from './typst'

/** The note as a typeset PDF, in a clean or a handwriting-style font. A course note's PDF goes into
 *  the course; others are saved where you choose. The first time downloads Typst (about 15 MB). */
export function TypesetButton({ note }: { note: Note }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  async function make(style: TypstStyle) {
    setOpen(false); setBusy(true)
    try {
      const source = noteTypst(note, style)
      // Without the internet the first time, math can't be typeset; it's kept as LaTeX instead.
      const b64 = await typstPdf(source).catch(e => /package|mitex/i.test(String(e)) ? typstPdf(withoutMitex(source)) : Promise.reject(e))
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      const title = noteTitle(note).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'Notes'
      const course = note.folder.startsWith('Study/') ? note.folder.slice(6).split('/')[0] : ''
      if (course) setNotice(`Saved ${await studySavePdf(course, title, bytes)} in ${course}.`)
      else { const path = await pickPdfSaveTo(`${title}.pdf`); if (path) { await studyDownloadPdf(path, bytes); setNotice('Saved the PDF.') } }
    } catch (e) { setNotice(errorText(e, 'The PDF wasn’t made')) } finally { setBusy(false) }
  }
  if (!isTauri()) return null
  return <span className="typeset">
    <button className="notes-icon" disabled={busy} title={busy ? 'Making the PDF… (the first time downloads Typst)' : 'A clean typeset PDF of this note'} onClick={() => setOpen(v => !v)}><FileType size={15} /></button>
    {open && <span className="typeset-menu"><button onClick={() => void make('clean')}>Clean font</button><button onClick={() => void make('hand')}>Handwriting font</button></span>}
  </span>
}
