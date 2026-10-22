import { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Camera, Check, Image, MessageCircleQuestion, Smartphone, Sparkles, X } from 'lucide-react'
import { chatgptAttachImage, chatgptRead, isTauri, pickTransferPaths, studyAddBooks } from '../../lib/bridge'
import { askMimir } from '../mimir'
import { askChatGPT } from '../../core/chatgpt'
import { activateTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import { dateInput, fromInputs } from '../calendar/model'
import { addAssignments, useAssignments } from './assignments'
import { courseMatches } from './canvas'
import { courseFolder } from './model'
import { dateHomework, homeworkPrompt, homeworkTitle, mimirHomeworkPrompt, readHomework } from './homework'
import { refreshLibrary } from './state'
import { classDaysOf } from './schedule'
import { libraryStore, termStore } from './state'
import { useStore } from '../../core/store'

const IMAGE = /\.(jpe?g|png|heic|webp|gif)$/i

/** Homework from a photo of the sheet: the photo goes to ChatGPT in the side panel (you send it),
 *  its answer comes back here, and the class days become dated assignments to check and add. */
export function HomeworkImport({ course, onClose }: { course: string; onClose: () => void }) {
  const existing = useAssignments()
  const [photo, setPhoto] = useState('')
  const [answer, setAnswer] = useState('')
  const term = useStore(termStore)
  const info = useStore(libraryStore).library?.courses.find(c => c.name === course)?.info
  // The semester's first day (Study → Semester) is the first week, unless the photo says otherwise.
  const [start, setStart] = useState(term?.start ?? '')
  const [time, setTime] = useState('23:59')
  const [nextClass, setNextClass] = useState(false)
  const [skip, setSkip] = useState<Set<number>>(new Set())
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  // A photo taken with the phone page (Devices → Phone) lands here.
  useEffect(() => {
    if (!isTauri()) return
    const stop = listen<{ name: string; path: string }>('phone-file', e => { if (IMAGE.test(e.payload.name)) { setPhoto(e.payload.path); setStatus('Photo from your phone.') } })
    const read = listen<{ ok: boolean; messages?: Array<{ role: string; text: string }>; message?: string }>('chatgpt-chat', e => {
      setBusy(false)
      const reply = e.payload.messages?.filter(m => m.role === 'assistant').at(-1)?.text
      if (!e.payload.ok || !reply) { setStatus(e.payload.message || 'ChatGPT hasn’t answered yet.'); return }
      setAnswer(reply)
      setStatus('')
    })
    return () => { void stop.then(f => f()); void read.then(f => f()) }
  }, [])

  const parsed = useMemo(() => readHomework(answer), [answer])
  useEffect(() => { if (parsed.semesterStart && !start) setStart(dateInput(parsed.semesterStart)) }, [parsed.semesterStart])
  const classDays = useMemo(() => info ? classDaysOf(info, term) : [], [info, term])
  const dated = useMemo(() => {
    if (!start || !parsed.rows.length) return []
    const rows = dateHomework(parsed.rows, fromInputs(start, '00:00'))
    const [h, m] = (time || '23:59').split(':').map(Number)
    return rows.map((row, i) => {
      // The next class: from the course's class times when it has them, else the sheet's next row.
      const later = classDays.find(d => d > row.date)
      const day = !nextClass ? row.date : later ?? (rows[i + 1] ? rows[i + 1].date : row.date)
      const due = new Date(day); due.setHours(h, m, 0, 0)
      return { ...row, due: due.getTime(), title: homeworkTitle(row) }
    })
  }, [parsed, start, time, nextClass, classDays])
  const already = useMemo(() => new Set(existing.filter(a => a.source === 'manual' && courseMatches(course, a.course)).map(a => a.title)), [existing, course])
  useEffect(() => { setSkip(new Set(dated.flatMap((row, i) => already.has(row.title) || (!row.text && !/exam|quiz|test|due/i.test(row.note)) ? [i] : []))) }, [dated.length, already])

  async function choose() {
    const path = (await pickTransferPaths(false)).find(p => IMAGE.test(p))
    if (path) { setPhoto(path); setStatus('') } else setStatus('Choose a photo (JPEG, PNG or HEIC).')
  }

  async function sendToChatGPT() {
    if (!photo) return
    await askChatGPT(homeworkPrompt(course), courseFolder(course))
    // The panel opens first; the photo follows (or waits for ChatGPT's page to load).
    window.setTimeout(() => void chatgptAttachImage(photo).then(() => setStatus('In ChatGPT: check the photo is attached, press send, and when it has answered, press “Get the answer”.')).catch(e => setStatus(errorText(e, 'Couldn’t attach the photo'))), 700)
  }

  /** Mimir reads it with the local vision model; its suggestions wait under “From Mimir”. */
  async function sendToMimir() {
    if (!photo) return
    try {
      // Mimir only looks at pictures in the Study library, so the photo is kept in the course.
      const root = libraryStore.get().library?.root ?? ''
      const already = root && photo.replace(/\\/g, '/').startsWith(`${root.replace(/\\/g, '/')}/${course}/`)
      const inCourse = already ? photo.split(/[\\/]/).pop()! : (await studyAddBooks(course, [photo]))[0]?.file
      if (!inCourse) { setStatus('Couldn’t keep the photo in the course.'); return }
      void refreshLibrary()
      await askMimir(mimirHomeworkPrompt(course, inCourse), true, course)
      setStatus('Mimir is reading it. What it finds waits in Study under “From Mimir” for you to add.')
    } catch (e) { setStatus(errorText(e, 'Couldn’t send it to Mimir')) }
  }

  async function getAnswer() {
    setBusy(true); setStatus('Reading ChatGPT’s answer…')
    try { await chatgptRead() } catch (e) { setBusy(false); setStatus(errorText(e, 'Open ChatGPT first')) }
    window.setTimeout(() => setBusy(false), 8000)
  }

  async function add() {
    const items = dated.filter((_, i) => !skip.has(i)).map(row => ({ course, title: row.text ? row.title : `${row.label} · ${row.note}`, due: row.due }))
    try {
      await addAssignments(items)
      setStatus(`Added ${items.length} assignment${items.length === 1 ? '' : 's'} to ${course}.`)
      setAnswer('')
    } catch (e) { setStatus(errorText(e, 'Couldn’t add them')) }
  }

  const fileName = photo.split(/[\\/]/).pop()
  return <div className="homework-import">
    <div className="homework-head"><strong><Camera size={15} /> Homework from a photo</strong><button className="cal-icon" title="Close" onClick={onClose}><X size={15} /></button></div>
    <ol className="homework-steps">
      <li>
        <span>Take a photo of the sheet with your phone (Computers tab → Phone page → send a file; it shows up here), or choose one on this computer.</span>
        <div className="actions">
          <button className="secondary" onClick={() => void choose()}><Image size={14} />Choose photo</button>
          <button className="secondary" title="Open the phone page’s QR code" onClick={() => activateTab('computers')}><Smartphone size={14} />Phone</button>
          {photo && <small className="homework-photo"><Check size={13} /> {fileName}</small>}
        </div>
      </li>
      <li>
        <span>Mimir reads it on your own computers (a model that reads pictures is needed), and suggests each due date for you to add. Or ChatGPT reads it: the photo and instructions go into the ChatGPT panel; press send there.</span>
        <div className="actions"><button disabled={!photo || !isTauri()} onClick={() => void sendToMimir()}><Sparkles size={14} />Read it with Mimir</button>
          <button className="secondary" disabled={!photo || !isTauri()} onClick={() => void sendToChatGPT()}><MessageCircleQuestion size={14} />Read it with ChatGPT</button>
          <button className="secondary" disabled={busy || !isTauri()} onClick={() => void getAnswer()}><Sparkles size={14} />{busy ? 'Reading…' : 'Get the answer'}</button></div>
      </li>
      <li>
        <span>Check the lines (or paste or type them: <code>M 1 | Ch 10.1: 3, 7-15 odd |</code>), and the semester’s first week.</span>
        <textarea rows={answer ? 6 : 3} value={answer} onChange={e => setAnswer(e.target.value)} placeholder={'WEEK | DAY | WORK | NOTE\n1 | M 1 | Ch 10.1: 3, 7-15 (odd), 18 |'} />
        <div className="homework-options">
          <label>First week of classes<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
          <label>Due at<input type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={nextClass} onChange={e => setNextClass(e.target.checked)} /> Due at the next class (not the day listed)</label>
        </div>
      </li>
    </ol>
    {parsed.rows.length > 0 && !start && <p className="hint">Pick the first week of classes to see the dates.</p>}
    {dated.length > 0 && <>
      <div className="homework-preview">{dated.map((row, i) => <label key={i} className={skip.has(i) ? 'skipped' : ''}>
        <input type="checkbox" checked={!skip.has(i)} onChange={() => setSkip(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })} />
        <span className="homework-date">{new Date(row.due).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        <span className="grow">{row.text ? row.title : `${row.label} · ${row.note}`}{row.note && row.text ? <em> {row.note}</em> : null}{already.has(row.title) ? <small> (already added)</small> : null}</span>
      </label>)}</div>
      <div className="actions"><button onClick={() => void add()} disabled={dated.length === skip.size}><Check size={14} />Add {dated.length - skip.size} to {course}</button></div>
    </>}
    {status && <p className="hint">{status}</p>}
  </div>
}
