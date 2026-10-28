import { useState } from 'react'
import { BookOpen, Download, Flag, Scissors, Trash2, X } from 'lucide-react'
import { pickPdfSaveTo, studyDownloadPdf, studyPatchCourseInfo, studySavePdf, type CourseInfo } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { chapterAt, chapterFileName, savedStarts, type Chapter } from './chapters'
import { newId } from '../notes/model'
import { readCollections } from './collections'
import { bookPages, loadBookBytes } from './pdf'
import { refreshLibrary } from './state'

type Folder = { id: string; title: string; files: string[] }

/** The book's chapters (and, for a book folder, its chapter files): go to one, mark where chapters
 *  start in a book without contents, download the book, a chapter or pages, or split a long book
 *  into chapter files that still open as one book. */
export function BookChapters({ course, file, title, info, pages, page, chapters, folder, onGo, onOpenFile, onClose, onStatus }: {
  course: string; file: string; title: string; info: CourseInfo | undefined; pages: number; page: number; chapters: Chapter[]
  folder: Folder | null; onGo: (page: number) => void; onOpenFile: (file: string) => void; onClose: () => void; onStatus: (s: string) => void
}) {
  const current = chapterAt(chapters, page)
  const [busy, setBusy] = useState('')
  const [range, setRange] = useState('')
  const own = info ? savedStarts(info, file) : []

  async function markHere() {
    const name = window.prompt(`Name the chapter that starts on page ${page}`, `Chapter ${own.length + 1}`)
    if (!name?.trim()) return
    await saveStarts([...own.filter(s => s.page !== page), { title: name.trim(), page }])
  }
  async function saveStarts(list: Array<{ title: string; page: number }>) {
    const all = info?.chapters && typeof info.chapters === 'object' ? { ...(info.chapters as Record<string, unknown>) } : {}
    if (list.length) all[file] = list.sort((a, b) => a.page - b.page)
    else delete all[file]
    try { await studyPatchCourseInfo(course, { chapters: all }); await refreshLibrary() } catch (e) { onStatus(errorText(e, 'Couldn’t save the chapters')) }
  }

  async function download(which: 'book' | 'chapter' | 'pages') {
    const ch = chapters[current]
    let start = 1, end = pages, name = title
    if (which === 'chapter' && ch) { start = ch.start; end = ch.end; name = `${title} — ${ch.title}` }
    if (which === 'pages') {
      const m = range.trim().match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/)
      if (!m) { onStatus('Pages like 12-30.'); return }
      start = Number(m[1]); end = Number(m[2] ?? m[1]); name = `${title} pp ${start}-${end}`
      if (start < 1 || end > pages || start > end) { onStatus(`Pages 1 to ${pages}.`); return }
    }
    const to = await pickPdfSaveTo(name)
    if (!to) return
    setBusy('download')
    try {
      const bytes = await loadBookBytes(course, file)
      const { splitPdf } = await import('../../lib/pdfwrite')
      // The part keeps its sections as bookmarks and the book's page numbers.
      const [part] = which === 'book' ? [new Uint8Array(bytes)] : await splitPdf(bytes, [{ start, end }], undefined, await bookPages(course, file).catch(() => ({})))
      await studyDownloadPdf(to, part)
      onStatus(`Saved ${to}.`)
    } catch (e) { onStatus(errorText(e, 'Couldn’t save it')) } finally { setBusy('') }
  }

  async function split() {
    if (chapters.length < 2) return
    if (!window.confirm(`Split “${title}” into ${chapters.length} chapter files? They open as one book (with the chapters to pick from), and the original stays as it is.`)) return
    setBusy('split')
    try {
      const { splitPdf } = await import('../../lib/pdfwrite')
      // Each chapter file keeps its sections and sub-sections as bookmarks (so it can be split
      // again) and the book's page numbers.
      const parts = await splitPdf(await loadBookBytes(course, file), chapters, done => setBusy(`split ${done}/${chapters.length}`), await bookPages(course, file).catch(() => ({})))
      const files: string[] = []
      for (const [i, part] of parts.entries()) files.push(await studySavePdf(course, chapterFileName(title, i, chapters[i].title), part))
      const collections = readCollections(info)
      await studyPatchCourseInfo(course, { collections: [...collections, { id: newId(), title, files, book: true }] })
      await refreshLibrary()
      onStatus(`Split into ${files.length} chapter files: “${title}” opens as one book.`)
      onOpenFile(files[Math.max(0, current)] ?? files[0])
    } catch (e) { onStatus(errorText(e, 'Couldn’t split it')) } finally { setBusy('') }
  }

  return <div className="book-chapters" role="dialog" aria-label="Chapters">
    <div className="cal-modal-head"><h3>{folder ? folder.title : title}</h3><button className="cal-icon" onClick={onClose} aria-label="Close"><X size={15} /></button></div>
    {folder && <>
      <strong className="book-chapters-label">Chapters (files)</strong>
      <ol className="book-chapter-list">{folder.files.map(f => <li key={f}><button className={f === file ? 'current' : ''} onClick={() => onOpenFile(f)}><BookOpen size={13} />{f.replace(/\.[^.]+$/, '').replace(`${folder.title} — `, '')}</button></li>)}</ol>
    </>}
    {chapters.length > 0 && <>
      {folder && <strong className="book-chapters-label">In this file</strong>}
      <ol className="book-chapter-list">{chapters.map((c, i) => <li key={`${c.start}-${i}`}>
        <button className={i === current ? 'current' : ''} onClick={() => { onGo(c.start); onClose() }}>{c.title}<small>{c.start === c.end ? `p. ${c.start}` : `pp. ${c.start}–${c.end}`}{i === current ? ' · reading' : i < current ? ' · read' : ''}</small></button>
        {own.some(s => s.page === c.start) && <button className="cal-icon" title="Remove this chapter start" onClick={() => void saveStarts(own.filter(s => s.page !== c.start))}><Trash2 size={12} /></button>}
      </li>)}</ol>
    </>}
    {!chapters.length && !folder && <p className="hint">This book has no contents to make chapters from. Go to where a chapter starts and mark it.</p>}
    <div className="actions book-chapters-actions">
      <button className="ghost" title="Mark the page being read as where a chapter starts" onClick={() => void markHere()}><Flag size={14} />Chapter starts here (p. {page})</button>
      {!folder && chapters.length >= 2 && <button className="ghost" disabled={!!busy} title="Make a file for each chapter, opening as one book" onClick={() => void split()}><Scissors size={14} />{busy.startsWith('split') ? `Splitting ${busy.slice(6)}…` : 'Split into chapter files'}</button>}
    </div>
    <div className="actions book-chapters-actions">
      <Download size={14} />
      <button className="ghost" disabled={!!busy} onClick={() => void download('book')}>{folder ? 'This chapter file' : 'Whole book'}</button>
      {current >= 0 && <button className="ghost" disabled={!!busy} onClick={() => void download('chapter')}>This chapter</button>}
      <input className="book-range" placeholder="Pages 12-30" value={range} onChange={e => setRange(e.target.value)} />
      <button className="ghost" disabled={!!busy || !range.trim()} onClick={() => void download('pages')}>Download pages</button>
    </div>
  </div>
}
