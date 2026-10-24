import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Camera, Crop, FileText, PenLine, Image, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { ScanCrop } from './ScanCrop'
import { ScanReview } from './ScanReview'
import { isTauri, notesCreateMarkdown, studyConvertHeic, studySavePhoto, openPath, pickTransferPaths, studyAddBooks, studyRemoveBook, type StudyBook } from '../../lib/bridge'
import { activateTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { notesStore, openNoteRequest } from '../notes/state'
import { courseFolder } from './model'
import { recogniseImage, stopRecognition } from './ocr'
import { refreshLibrary } from './state'

export const PHOTO_KINDS = ['jpg', 'jpeg', 'png', 'heic', 'webp']
const IMAGE = /\.(jpe?g|png|heic|webp)$/i
export const isPhoto = (book: StudyBook) => PHOTO_KINDS.includes(book.kind)

/** Photos of notes and whiteboards kept with the course (on both computers). Each new one is read
 *  by text recognition into a note in the course's folder, so its words turn up in search. */
export function CoursePhotos({ course, photos, root }: { course: string; photos: StudyBook[]; root: string }) {
  const [waiting, setWaiting] = useState(false)
  const [status, setStatus] = useState('')

  async function add(paths: string[]) {
    try {
      const added = await studyAddBooks(course, paths)
      // HEIC (the iPhone's usual format) is made JPEG first, so it can be read and straightened.
      for (const [i, photo] of added.entries()) {
        if (!/\.heic$/i.test(photo.file)) continue
        setStatus(`Converting ${photo.file}…`)
        try { added[i] = { ...photo, file: await studyConvertHeic(course, photo.file) } } catch (e) { setStatus(errorText(e, 'Couldn’t convert the HEIC photo')) }
      }
      await refreshLibrary()
      for (const photo of added) {
        if (/\.heic$/i.test(photo.file)) continue
        setStatus(`Reading the text in ${photo.file}…`)
        const text = await recogniseImage(convertFileSrc(`${course}/${photo.file}`, 'bdbook')).catch(e => { setStatus(`The text in ${photo.file} couldn’t be read: ${errorText(e, 'unknown error')}`); return '' })
        const when = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        const note = await notesCreateMarkdown(`${course} photo · ${when}`, courseFolder(course), 'note', `${text.trim() || '(No text recognised.)'}\n\n*From the photo ${photo.file} in the ${course} folder.*`)
        notesStore.set(list => [note, ...list])
      }
      void stopRecognition()
      setStatus(`Added ${added.length} photo${added.length === 1 ? '' : 's'}, with their text in Notes.`)
    } catch (e) { setStatus(errorText(e, 'Couldn’t add the photo')) }
  }

  useEffect(() => {
    if (!waiting || !isTauri()) return
    const stop = listen<{ name: string; path: string }>('phone-file', e => { if (IMAGE.test(e.payload.name)) { setWaiting(false); void add([e.payload.path]) } })
    return () => void stop.then(f => f())
  }, [waiting, course])

  async function choose() {
    const paths = (await pickTransferPaths(false)).filter(p => IMAGE.test(p))
    if (paths.length) void add(paths); else setStatus('Choose photos (JPEG, PNG, HEIC).')
  }
  async function remove(photo: StudyBook) {
    if (!window.confirm(`Remove ${photo.file} from ${course}? Its note stays.`)) return
    try { await studyRemoveBook(course, photo.file); await refreshLibrary() } catch (e) { setStatus(errorText(e, 'Couldn’t remove it')) }
  }
  const [cropping, setCropping] = useState<StudyBook | null>(null)
  const [reviewing, setReviewing] = useState<StudyBook | null>(null)
  /** A straightened, whitened copy of a page photo, added beside it (and read like any photo). */
  async function keepStraightened(photo: StudyBook, jpeg: Blob) {
    setCropping(null)
    try {
      const file = await studySavePhoto(course, `${photo.title} (scan)`, new Uint8Array(await jpeg.arrayBuffer()))
      await refreshLibrary()
      setStatus(`Saved ${file}.`)
      void readInto(file)
    } catch (e) { setStatus(errorText(e, 'Couldn’t save it')) }
  }
  async function readInto(file: string) {
    const text = await recogniseImage(convertFileSrc(`${course}/${file}`, 'bdbook')).catch(e => { setStatus(`The text couldn’t be read: ${errorText(e, 'unknown error')}`); return '' })
    void stopRecognition()
    if (!text.trim()) return
    const note = await notesCreateMarkdown(`${course} scan · ${file}`, courseFolder(course), 'note', `${text.trim()}\n\n*From the photo ${file} in the ${course} folder.*`)
    notesStore.set(list => [note, ...list])
  }
  async function convert(photo: StudyBook) {
    setStatus(`Converting ${photo.file}…`)
    try { const file = await studyConvertHeic(course, photo.file); await refreshLibrary(); setStatus(`Converted to ${file}.`); void readInto(file) } catch (e) { setStatus(errorText(e, 'Couldn’t convert it')) }
  }
  const noteFor = (photo: StudyBook) => notesStore.get().find(n => !n.deleted && n.folder.toLowerCase() === courseFolder(course).toLowerCase() && n.blocks.some(b => !b.deleted && b.text.includes(`photo ${photo.file}`)))

  return <Card><SectionTitle title="Photos" subtitle="Notes and whiteboards, read into text you can search" action={<div className="actions">
    <button className={waiting ? '' : 'secondary'} title="Take it with the phone page (Computers → Phone): it lands here" onClick={() => setWaiting(v => !v)}><Smartphone size={14} />{waiting ? 'Waiting for your phone…' : 'From phone'}</button>
    <button className="secondary" onClick={() => void choose()}><Image size={14} />Choose</button>
  </div>} />
    {waiting && <p className="hint">Open the phone page on your phone (Computers tab → Phone), take the photo and send it: it’s added to {course}.</p>}
    {photos.length ? <div className="course-photos">{photos.map(p => { const note = noteFor(p); return <figure key={p.file}>
      <button className="course-photo" title="Open the photo" onClick={() => void openPath(`${root}/${course}/${p.file}`)}><img src={convertFileSrc(`${course}/${p.file}`, 'bdbook')} alt={p.title} loading="lazy" /></button>
      <figcaption><span title={p.file}>{p.title}</span>
        {note && <button className="cal-icon" title="Open its text in Notes" onClick={() => { openNoteRequest.set(note.id); activateTab('notes') }}><FileText size={12} /></button>}
        {/\.heic$/i.test(p.file) && <button className="cal-icon" title="Convert to JPEG, so it can be straightened and read" onClick={() => void convert(p)}><RefreshCw size={12} /></button>}
        {!/\.heic$/i.test(p.file) && <button className="cal-icon" title="Straighten and whiten the page" onClick={() => setCropping(p)}><Crop size={12} /></button>}
        {!/\.heic$/i.test(p.file) && <button className="cal-icon" title="Read the handwriting into a note (check it first)" onClick={() => setReviewing(p)}><PenLine size={12} /></button>}
        <button className="cal-icon" title="Remove" onClick={() => void remove(p)}><Trash2 size={12} /></button></figcaption>
    </figure> })}</div> : !waiting && <p className="hint"><Camera size={13} /> Snap a page of notes or the whiteboard after class; its text goes into a note for this course.</p>}
    {status && <p className="hint">{status}</p>}
    {reviewing && <ScanReview course={course} file={reviewing.file} src={convertFileSrc(`${course}/${reviewing.file}`, 'bdbook')} onClose={() => setReviewing(null)} onStatus={setStatus} />}
    {cropping && <ScanCrop src={convertFileSrc(`${course}/${cropping.file}`, 'bdbook')} onCancel={() => setCropping(null)} onDone={jpeg => void keepStraightened(cropping, jpeg)} />}
  </Card>
}
