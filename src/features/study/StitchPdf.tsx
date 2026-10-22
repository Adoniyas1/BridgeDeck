import { useState } from 'react'
import { ArrowDown, ArrowUp, FilePlus, RotateCw, X } from 'lucide-react'
import { pickTransferPaths, studyAddBooks, studySavePdf, type StudyBook, type StudyCourse } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { parsePages, stitchPdf, type StitchPart } from '../../lib/pdfwrite'
import { loadBookBytes, pdfjs } from './pdf'
import { openBook } from './open'
import { refreshLibrary } from './state'

const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' }
const stitchable = (book: StudyBook) => book.kind === 'pdf' || book.kind in IMAGE_MIME

/** A file chosen for the stitched PDF: which pages (PDFs) and how much to turn it. */
type Pick = { key: string; file: string; title: string; kind: string; pages: string; count: number | null; rotate: number }

/** Stitch PDFs: homework pages, scans and photos from a course, in the order picked, as one PDF
 *  saved in the course (so it syncs, and it's ready to upload). */
export function StitchPdf({ course, onClose, onStatus }: { course: StudyCourse; onClose: () => void; onStatus: (s: string) => void }) {
  const sources = course.books.filter(stitchable)
  const [picks, setPicks] = useState<Pick[]>([])
  const [name, setName] = useState(() => `${course.info.code || course.name} homework ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function add(book: StudyBook) {
    const key = `${book.file}:${Date.now()}`
    setPicks(list => [...list, { key, file: book.file, title: book.title, kind: book.kind, pages: '', count: book.kind === 'pdf' ? null : 1, rotate: 0 }])
    if (book.kind !== 'pdf') return
    // How many pages it has, to check page lists against.
    try {
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await loadBookBytes(course.name, book.file)), isEvalSupported: false }).promise
      const count = doc.numPages
      void doc.destroy()
      setPicks(list => list.map(p => p.key === key ? { ...p, count } : p))
    } catch { /* checked when it's stitched */ }
  }
  const move = (i: number, by: number) => setPicks(list => { const next = [...list]; const [p] = next.splice(i, 1); next.splice(i + by, 0, p); return next })
  const update = (key: string, change: Partial<Pick>) => setPicks(list => list.map(p => p.key === key ? { ...p, ...change } : p))

  async function addFiles() {
    const paths = (await pickTransferPaths(false)).filter(p => /\.(pdf|jpe?g|png|webp|heic)$/i.test(p))
    if (!paths.length) return
    try {
      const added = await studyAddBooks(course.name, paths)
      await refreshLibrary()
      for (const book of added) await add(book)
    } catch (e) { setError(errorText(e, 'The files couldn’t be added')) }
  }

  async function make() {
    setBusy(true); setError('')
    try {
      const parts: StitchPart[] = []
      for (const p of picks) {
        const pages = p.kind === 'pdf' && p.pages.trim() ? parsePages(p.pages, p.count ?? 9999) : undefined
        if (pages === null) throw new Error(`“${p.pages}” isn’t a page list (like 1-3, 5) for ${p.title}.`)
        const bytes = await loadBookBytes(course.name, p.file)
        parts.push(p.kind === 'pdf' ? { bytes, kind: 'pdf', pages, rotate: p.rotate } : { bytes, kind: 'image', mime: IMAGE_MIME[p.kind], rotate: p.rotate })
      }
      const file = await studySavePdf(course.name, name, await stitchPdf(parts))
      await refreshLibrary()
      onStatus(`Saved ${file} in ${course.name}.`)
      openBook(course.name, file, file.replace(/\.pdf$/i, ''))
      onClose()
    } catch (e) { setError(errorText(e, 'The PDF couldn’t be made')) } finally { setBusy(false) }
  }

  return <div className="cal-modal-back" onClick={onClose}>
    <div className="card stitch" onClick={e => e.stopPropagation()}>
      <div className="cal-modal-head"><h3>Stitch PDFs</h3><button className="cal-icon" onClick={onClose} aria-label="Close"><X size={15} /></button></div>
      <p className="hint">Pick PDFs and photos in the order they should go. They become one PDF in {course.name}, ready to upload.</p>
      <div className="stitch-cols">
        <div className="stitch-sources">
          <strong>In {course.name}</strong>
          {sources.map(book => <button key={book.file} className="ghost" onClick={() => void add(book)} title="Add to the end"><span>{book.title}</span><small>{book.kind.toUpperCase()}</small></button>)}
          {!sources.length && <p className="hint">No PDFs or photos here yet.</p>}
          <button className="secondary" onClick={() => void addFiles()}><FilePlus size={14} />Add files…</button>
        </div>
        <ol className="stitch-picks">
          {picks.map((p, i) => <li key={p.key}>
            <span className="grow">{p.title}<small>{p.kind === 'pdf' ? (p.count ? ` · ${p.count} pages` : '') : ' · photo'}{p.rotate ? ` · turned ${p.rotate}°` : ''}</small></span>
            {p.kind === 'pdf' && <input className="stitch-pages" placeholder="All pages" title="Pages, like 1-3, 5 (blank: all)" value={p.pages} onChange={e => update(p.key, { pages: e.target.value })} />}
            <button className="cal-icon" title="Turn a quarter" onClick={() => update(p.key, { rotate: (p.rotate + 90) % 360 })}><RotateCw size={14} /></button>
            <button className="cal-icon" title="Earlier" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
            <button className="cal-icon" title="Later" disabled={i === picks.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
            <button className="cal-icon" title="Take out" onClick={() => setPicks(list => list.filter(x => x.key !== p.key))}><X size={14} /></button>
          </li>)}
          {!picks.length && <p className="hint">Nothing picked yet: click files on the left.</p>}
        </ol>
      </div>
      {error && <p className="notes-error">{error}</p>}
      <div className="actions">
        <label className="grow stitch-name">Name<input value={name} onChange={e => setName(e.target.value)} /></label>
        <button disabled={busy || !picks.length || !name.trim()} onClick={() => void make()}>{busy ? 'Stitching…' : 'Make PDF'}</button>
      </div>
    </div>
  </div>
}
