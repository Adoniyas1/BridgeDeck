import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Download, FileAudio, HelpCircle, Mic, Play, Square, Trash2 } from 'lucide-react'
import { isTauri, modelsDownload, modelsRemove, modelsStatus, pickTransferPaths, studyImportLecture, studyLectures, studyPatchCourseInfo, type CourseInfo, type LectureFile, type ModelsStatus } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { clock, LIVE_WINDOW, MODELS, type ModelId } from './lecture'
import { lectureJobStore, markLost, startRecording, stopRecording, transcribeLectureFile } from './lectureJob'
import { openLecture } from './open'
import { refreshLibrary } from './state'

const MODEL_KEY = 'bd-lecture-model'
const AUDIO = /\.(m4a|mp3|webm|ogg|wav|aac)$/i

/** Lectures for a course: recorded here (only when the course allows it) or imported, kept in its
 *  Lectures folder on both computers, transcribed on this computer by Whisper (nothing leaves it),
 *  each with a dated note and a player whose transcript lines play from their time. */
export function LectureCard({ course, info }: { course: string; info: CourseInfo }) {
  const [status, setStatus] = useState<ModelsStatus | null>(null)
  const [model, setModel] = useState<ModelId>(() => { try { return (localStorage.getItem(MODEL_KEY) as ModelId) || 'fast' } catch { return 'fast' } })
  // Recording and transcribing run in lectureJob.ts and keep going whatever tab is open; this card
  // shows them for its course.
  const job = useStore(lectureJobStore)
  const mine = job.course === course
  const phase = mine ? job.phase : 'idle'
  const busyElsewhere = !mine && job.phase !== 'idle'
  const { started, progress, heard } = job
  const [, tick] = useState(0)
  const [download, setDownload] = useState<{ mb: number; of: number } | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [lectures, setLectures] = useState<LectureFile[]>([])
  const [words, setWords] = useState(() => Array.isArray(info.words) ? (info.words as string[]).join('\n') : '')
  // The transcript while recording (the full pass at the end replaces it).
  const [liveOn, setLiveOn] = useState(() => { try { return localStorage.getItem('bd-lecture-live') !== 'off' } catch { return true } })
  const liveBox = useRef<HTMLDivElement>(null)
  useEffect(() => { liveBox.current?.scrollTo({ top: liveBox.current.scrollHeight }) }, [heard])
  const allowed = info.recording === true

  const reload = () => { if (isTauri()) void studyLectures(course).then(setLectures).catch(() => undefined) }
  useEffect(() => {
    if (!isTauri()) return
    void modelsStatus().then(setStatus).catch(() => undefined)
    reload()
    const stop = listen<{ model: string; mb: number; of: number }>('model-progress', e => setDownload({ mb: e.payload.mb, of: e.payload.of }))
    return () => { void stop.then(f => f()).catch(() => undefined) }
  }, [course])
  // A lecture saved or transcribed (here or while away): the list is read again.
  useEffect(() => { if (mine && job.saved) reload() }, [job.saved])
  useEffect(() => {
    if (phase !== 'recording') return
    const id = window.setInterval(() => tick(n => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [phase])

  const ready = !!status?.engine && !!status.models.includes(model)
  const choose = (id: ModelId) => { setModel(id); try { localStorage.setItem(MODEL_KEY, id) } catch { /* not remembered */ } }

  async function getModel() {
    setError(''); setDownload({ mb: 0, of: MODELS.find(m => m.id === model)!.size })
    try { setStatus(await modelsDownload(model)) } catch (e) { setError(errorText(e, 'The download didn’t finish')) } finally { setDownload(null) }
  }

  async function setAllowed(on: boolean) {
    try { await studyPatchCourseInfo(course, { recording: on || null }); await refreshLibrary() } catch (e) { setError(String(e)) }
  }
  async function saveWords() {
    const list = words.split('\n').map(w => w.trim()).filter(Boolean)
    try { await studyPatchCourseInfo(course, { words: list.length ? list : null }); await refreshLibrary(); setMessage('Saved the word list.') } catch (e) { setError(String(e)) }
  }

  async function start() {
    setError(''); setMessage('')
    if (!allowed) { setError('Recording is off for this course. Turn it on only if the class allows it.'); return }
    try { await startRecording(course, model, info.words, liveOn) } catch (e) { setError(errorText(e, 'Couldn’t start recording')) }
  }

  async function importAudio() {
    setError(''); setMessage('')
    const path = (await pickTransferPaths(false)).find(p => AUDIO.test(p))
    if (!path) { setError('Choose an audio file (m4a, mp3, webm, ogg or wav).'); return }
    try {
      const file = await studyImportLecture(course, path)
      reload()
      await transcribeLectureFile(course, file, Date.now(), model, info.words)
    } catch (e) { setError(errorText(e, 'Couldn’t import it')) }
  }

  return <Card><SectionTitle title="Lectures" subtitle="Recorded or imported, transcribed on this computer" action={<Mic size={18} />} />
    <label className="study-quiet"><input type="checkbox" checked={allowed} onChange={e => void setAllowed(e.target.checked)} /> This class may be recorded (ask first; off unless you turn it on)</label>
    {phase === 'recording' && <div className="lecture-live"><span className="lecture-dot" /> Recording {clock((Date.now() - started) / 1000)}
      <button className="ghost" title="Mark a moment you got lost, to come back to" onClick={markLost}><HelpCircle size={14} /> Lost here</button>
      <button className="danger" onClick={stopRecording}><Square size={14} /> Stop and transcribe</button></div>}
    {phase === 'recording' && liveOn && <div ref={liveBox} className="lecture-live-text">{heard.length ? heard.map((s, i) => <p key={i}><span className="lecture-time">{clock(s.start)}</span>{s.text}</p>) : <p className="hint">The transcript appears here about every {LIVE_WINDOW} seconds.</p>}</div>}
    {phase === 'transcribing' && <p className="hint">Transcribing… {Math.round(progress * 100)}% (it carries on in other tabs; keep BridgeDeck open, an hour of audio takes a while)</p>}
    {busyElsewhere && <p className="hint">{job.phase === 'recording' ? 'Recording' : 'Transcribing'} {job.course}’s lecture; one at a time.</p>}
    {phase === 'idle' && <>
      <label className="study-quiet"><input type="checkbox" checked={liveOn} onChange={e => { setLiveOn(e.target.checked); try { localStorage.setItem('bd-lecture-live', e.target.checked ? 'on' : 'off') } catch { /* not remembered */ } }} /> Show the transcript while recording (uses more of the computer; Fast is best on the Mac)</label>
      <div className="lecture-models">{MODELS.map(m => <label key={m.id}><input type="radio" name={`lecture-model-${course}`} checked={model === m.id} onChange={() => choose(m.id)} /> {m.label} <small>({m.size} MB{status?.models.includes(m.id) ? ', downloaded' : ''})</small></label>)}</div>
      {!isTauri() ? <p className="hint">Lectures work in the BridgeDeck app.</p>
        : ready ? <div className="actions">
          <button disabled={!allowed || busyElsewhere} title={allowed ? undefined : 'Turn on recording for this course first'} onClick={() => void start()}><Mic size={15} /> Record</button>
          <button className="secondary" onClick={() => void importAudio()}><FileAudio size={15} /> Import audio</button>
          <button className="ghost" title="Remove this model from this computer" onClick={() => void modelsRemove(model).then(setStatus)}><Trash2 size={14} /></button>
        </div>
        : <div className="actions"><button disabled={!!download || status?.downloading} onClick={() => void getModel()}><Download size={15} />{download ? `Downloading… ${download.mb} of ~${download.of} MB` : `Download the ${MODELS.find(m => m.id === model)!.label.toLowerCase()} model (once)`}</button></div>}
    </>}
    {lectures.length > 0 && <div className="lecture-list">{lectures.map(l => <div key={l.file} className="lecture-row">
      <button className="ghost grow" onClick={() => openLecture(course, l.file)}><Play size={13} /> {l.file.replace(/\.[^.]+$/, '')}</button>
      <small>{Math.round(l.bytes / 1_048_576)} MB{l.sidecar?.markers?.length ? ` · ${l.sidecar.markers.length} ?` : ''}</small>
      {!l.sidecar?.segments && job.phase === 'idle' && ready && <button className="ghost" onClick={() => void transcribeLectureFile(course, l.file, l.modified, model, info.words).catch(e => setError(String(e)))}>Transcribe</button>}
    </div>)}</div>}
    <details className="lecture-words"><summary>Course words for transcripts</summary>
      <textarea rows={4} value={words} onChange={e => setWords(e.target.value)} placeholder={'Kirchhoff\nMOSFET\nkirk off => Kirchhoff'} />
      <button className="ghost" onClick={() => void saveWords()}>Save words</button>
    </details>
    {(message || (mine && job.message)) && <p className="hint">{message || job.message}</p>}
    {(error || (mine && job.error)) && <p className="error-text">{error || job.error}</p>}
  </Card>
}
