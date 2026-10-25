import { useState } from 'react'
import { FileType } from 'lucide-react'
import { isTauri, pickPdfSaveTo, studyDownloadPdf, studySavePdf, typstPdf, type Note } from '../../lib/bridge'
import { setNotice } from '../../core/notice'
import { errorText } from '../../core/util'
import { useStore } from '../../core/store'
import { libraryStore } from '../study/state'
import { noteTitle } from './model'
import { noteTypst, withoutMitex, type TypstStyle } from './typst'

/** The note as a typeset PDF, in a clean or a handwriting-style font. A course note's PDF goes into
 *  the course; others are saved where you choose. The first time downloads Typst (about 15 MB). */
export function TypesetButton({ note }: { note: Note }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const course = note.folder.startsWith('Study/') ? note.folder.slice(6).split('/')[0] : ''
  // A course note (a lab report) can carry the course's PDFs and pictures after it: printouts,
  // scope captures, the Logic or Code report.
  const files = (useStore(libraryStore).library?.courses.find(c => c.name === course)?.books ?? []).filter(b => ['pdf', 'jpg', 'jpeg', 'png'].includes(b.kind))
  const [attaching, setAttaching] = useState(false)
  const [attached, setAttached] = useState<string[]>([])
  async function make(style: TypstStyle, attach: string[] = []) {
    setOpen(false); setAttaching(false); setBusy(true)
    try {
      const source = noteTypst(note, style)
      // Without the internet the first time, math can't be typeset; it's kept as LaTeX instead.
      const b64 = await typstPdf(source).catch(e => /package|mitex/i.test(String(e)) ? typstPdf(withoutMitex(source)) : Promise.reject(e))
      let bytes: Uint8Array = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      if (attach.length) {
        const [{ stitchPdf }, { loadBookBytes }] = await Promise.all([import('../../lib/pdfwrite'), import('../study/pdf')])
        const parts = await Promise.all(attach.map(async file => {
          const kind = file.toLowerCase().split('.').pop()!
          const buffer = await loadBookBytes(course, file)
          return kind === 'pdf' ? { bytes: buffer, kind: 'pdf' as const } : { bytes: buffer, kind: 'image' as const, mime: kind === 'png' ? 'image/png' : 'image/jpeg' }
        }))
        bytes = await stitchPdf([{ bytes: bytes.slice().buffer as ArrayBuffer, kind: 'pdf' }, ...parts])
      }
      const title = noteTitle(note).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'Notes'
      if (course) setNotice(`Saved ${await studySavePdf(course, title, bytes)} in ${course}.`)
      else { const path = await pickPdfSaveTo(`${title}.pdf`); if (path) { await studyDownloadPdf(path, bytes); setNotice('Saved the PDF.') } }
    } catch (e) { setNotice(errorText(e, 'The PDF wasn’t made')) } finally { setBusy(false) }
  }
  if (!isTauri()) return null
  return <span className="typeset">
    <button className="notes-icon" disabled={busy} title={busy ? 'Making the PDF… (the first time downloads Typst)' : 'A clean typeset PDF of this note'} onClick={() => setOpen(v => !v)}><FileType size={15} /></button>
    {open && <span className="typeset-menu"><button onClick={() => void make('clean')}>Clean font</button><button onClick={() => void make('hand')}>Handwriting font</button>
      {course && files.length > 0 && <button onClick={() => { setOpen(false); setAttaching(true) }}>With {course} files attached…</button>}</span>}
    {attaching && <span className="typeset-menu typeset-attach">
      <strong>Put after the note</strong>
      {files.map(f => <label key={f.file}><input type="checkbox" checked={attached.includes(f.file)} onChange={e => setAttached(list => e.target.checked ? [...list, f.file] : list.filter(x => x !== f.file))} />{f.title || f.file}</label>)}
      <span className="actions"><button disabled={!attached.length} onClick={() => void make('clean', attached)}>Make the PDF</button><button className="ghost" onClick={() => setAttaching(false)}>Cancel</button></span>
    </span>}
  </span>
}
