import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Download, FileAudio, HelpCircle, Mic, Play, Square, Trash2 } from 'lucide-react'
import { isTauri, modelsDownload, modelsRemove, modelsStatus, notesCreateMarkdown, pickTransferPaths, studyImportLecture, studyLecturePut, studyLectures, studyPatchCourseInfo, studySaveLecture, type CourseInfo, type LectureFile, type ModelsStatus } from '../../lib/bridge'
import { examOn } from '../../core/exam'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { notesStore } from '../notes/state'
import { clock, correctWords, lectureNoteMarkdown, listenInWindows, LiveTranscriber, LIVE_WINDOW, MODELS, toSamples, transcribe, wordFixes, type ModelId, type Segment } from './lecture'
import { courseFolder, lectureLink } from './model'
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
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [started, setStarted] = useState(0)
  const [, tick] = useState(0)
  const [progress, setProgress] = useState(0)
  const [download, setDownload] = useState<{ mb: number; of: number } | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [lectures, setLectures] = useState<LectureFile[]>([])
  const [words, setWords] = useState(() => Array.isArray(info.words) ? (info.words as string[]).join('\n') : '')
  const recorder = useRef<MediaRecorder | null>(null)
  const parts = useRef<Blob[]>([])
  const marks = useRef<number[]>([])
  // The transcript while recording (the full pass at the end replaces it).
  const [liveOn, setLiveOn] = useState(() => { try { return localStorage.getItem('bd-lecture-live') !== 'off' } catch { return true } })
  const [heard, setHeard] = useState<Segment[]>([])
  const live = useRef<{ stop: () => void } | null>(null)
  const liveBox = useRef<HTMLDivElement>(null)
  useEffect(() => { liveBox.current?.scrollTo({ top: liveBox.current.scrollHeight }) }, [heard])
  // Leaving the course while recording: the recording is stopped and saved (it would otherwise
  // keep the microphone on with nothing on screen, and never be kept).
  useEffect(() => () => { if (recorder.current?.state === 'recording') recorder.current.stop(); else live.current?.stop() }, [])
  const allowed = info.recording === true

  const reload = () => { if (isTauri()) void studyLectures(course).then(setLectures).catch(() => undefined) }
  useEffect(() => {
    if (!isTauri()) return
    void modelsStatus().then(setStatus).catch(() => undefined)
    reload()
    const stop = listen<{ model: string; mb: number; of: number }>('model-progress', e => setDownload({ mb: e.payload.mb, of: e.payload.of }))
    return () => { void stop.then(f => f()).catch(() => undefined) }
  }, [course])
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
    if (examOn()) { setError('Recording is off during exam mode.'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } })
      const rec = new MediaRecorder(stream)
      parts.current = []; marks.current = []
      const at = Date.now()
      rec.ondataavailable = e => { if (e.data.size) parts.current.push(e.data) }
      setHeard([])
      if (liveOn) {
        const fixes = wordFixes(info.words)
        const transcriber = new LiveTranscriber(model, s => setHeard(h => [...h, ...correctWords(s, fixes)]), m => setMessage(`Live transcript stopped: ${m}`))
        const stopListening = listenInWindows(stream, LIVE_WINDOW, (samples, offset) => { if (!examOn()) transcriber.push(samples, offset) })
        live.current = { stop: () => { stopListening(); transcriber.stop() } }
      }
      rec.onstop = () => { live.current?.stop(); live.current = null; stream.getTracks().forEach(t => t.stop()); void finishRecording(new Blob(parts.current, { type: rec.mimeType }), at) }
      rec.start(10_000)
      recorder.current = rec
      setStarted(at)
      setPhase('recording')
    } catch (e) {
      setError(`The microphone couldn’t be used: ${errorText(e, 'permission denied')}. Allow BridgeDeck to use the microphone in your system settings.`)
    }
  }

  async function finishRecording(recording: Blob, at: number) {
    const when = new Date(at)
    const name = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} Lecture`
    try {
      // The audio is kept first, so a failed transcription loses nothing.
      const file = await studySaveLecture(course, name, new Uint8Array(await recording.arrayBuffer()))
      reload()
      await transcribeInto(file, recording, at, marks.current)
    } catch (e) { setError(`Saving the recording didn’t work: ${errorText(e, 'unknown error')}`); setPhase('idle') }
  }

  async function importAudio() {
    setError(''); setMessage('')
    const path = (await pickTransferPaths(false)).find(p => AUDIO.test(p))
    if (!path) { setError('Choose an audio file (m4a, mp3, webm, ogg or wav).'); return }
    try {
      const file = await studyImportLecture(course, path)
      reload()
      await transcribeFile(file)
    } catch (e) { setError(errorText(e, 'Couldn’t import it')) }
  }

  async function transcribeFile(file: string, at = Date.now()) {
    const response = await fetch(convertFileSrc(`${course}/Lectures/${file}`, 'bdbook'))
    await transcribeInto(file, await response.blob(), at, [])
  }

  /** Transcribes a kept recording, fixes the course's words, and saves the transcript beside it
   *  with a dated note linking to it. */
  async function transcribeInto(file: string, audio: Blob, at: number, markers: number[]) {
    setPhase('transcribing'); setProgress(0)
    try {
      const samples = await toSamples(audio)
      const length = clock(samples.length / 16000)
      const segments: Segment[] = correctWords(await transcribe(samples, model, setProgress), wordFixes(info.words))
      const when = new Date(at)
      const title = `${course} — lecture ${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      const note = await notesCreateMarkdown(title, courseFolder(course), 'note', lectureNoteMarkdown(when, length, segments, t => lectureLink(course, file, t)))
      notesStore.set(list => [note, ...list])
      await studyLecturePut(course, file, { segments, markers: markers.map(t => ({ t })), started: at, note: note.id })
      reload()
      setMessage(`Transcribed “${file}” and made the note “${title}”.`)
      openLecture(course, file)
    } catch (e) {
      setError(`Transcribing didn’t work: ${errorText(e, 'unknown error')}. The recording is kept; try again from the list.`)
    } finally {
      setPhase('idle')
    }
  }

  return <Card><SectionTitle title="Lectures" subtitle="Recorded or imported, transcribed on this computer" action={<Mic size={18} />} />
    <label className="study-quiet"><input type="checkbox" checked={allowed} onChange={e => void setAllowed(e.target.checked)} /> This class may be recorded (ask first; off unless you turn it on)</label>
    {phase === 'recording' && <div className="lecture-live"><span className="lecture-dot" /> Recording {clock((Date.now() - started) / 1000)}
      <button className="ghost" title="Mark a moment you got lost, to come back to" onClick={() => { marks.current.push((Date.now() - started) / 1000); setMessage(`Marked ${clock((Date.now() - started) / 1000)}.`) }}><HelpCircle size={14} /> Lost here</button>
      <button className="danger" onClick={() => recorder.current?.stop()}><Square size={14} /> Stop and transcribe</button></div>}
    {phase === 'recording' && liveOn && <div ref={liveBox} className="lecture-live-text">{heard.length ? heard.map((s, i) => <p key={i}><span className="lecture-time">{clock(s.start)}</span>{s.text}</p>) : <p className="hint">The transcript appears here about every {LIVE_WINDOW} seconds.</p>}</div>}
    {phase === 'transcribing' && <p className="hint">Transcribing… {Math.round(progress * 100)}% (keep BridgeDeck open; an hour of audio takes a while)</p>}
    {phase === 'idle' && <>
      <label className="study-quiet"><input type="checkbox" checked={liveOn} onChange={e => { setLiveOn(e.target.checked); try { localStorage.setItem('bd-lecture-live', e.target.checked ? 'on' : 'off') } catch { /* not remembered */ } }} /> Show the transcript while recording (uses more of the computer; Fast is best on the Mac)</label>
      <div className="lecture-models">{MODELS.map(m => <label key={m.id}><input type="radio" name={`lecture-model-${course}`} checked={model === m.id} onChange={() => choose(m.id)} /> {m.label} <small>({m.size} MB{status?.models.includes(m.id) ? ', downloaded' : ''})</small></label>)}</div>
      {!isTauri() ? <p className="hint">Lectures work in the BridgeDeck app.</p>
        : ready ? <div className="actions">
          <button disabled={!allowed} title={allowed ? undefined : 'Turn on recording for this course first'} onClick={() => void start()}><Mic size={15} /> Record</button>
          <button className="secondary" onClick={() => void importAudio()}><FileAudio size={15} /> Import audio</button>
          <button className="ghost" title="Remove this model from this computer" onClick={() => void modelsRemove(model).then(setStatus)}><Trash2 size={14} /></button>
        </div>
        : <div className="actions"><button disabled={!!download || status?.downloading} onClick={() => void getModel()}><Download size={15} />{download ? `Downloading… ${download.mb} of ~${download.of} MB` : `Download the ${MODELS.find(m => m.id === model)!.label.toLowerCase()} model (once)`}</button></div>}
    </>}
    {lectures.length > 0 && <div className="lecture-list">{lectures.map(l => <div key={l.file} className="lecture-row">
      <button className="ghost grow" onClick={() => openLecture(course, l.file)}><Play size={13} /> {l.file.replace(/\.[^.]+$/, '')}</button>
      <small>{Math.round(l.bytes / 1_048_576)} MB{l.sidecar?.markers?.length ? ` · ${l.sidecar.markers.length} ?` : ''}</small>
      {!l.sidecar?.segments && phase === 'idle' && ready && <button className="ghost" onClick={() => void transcribeFile(l.file, l.modified).catch(e => setError(String(e)))}>Transcribe</button>}
    </div>)}</div>}
    <details className="lecture-words"><summary>Course words for transcripts</summary>
      <textarea rows={4} value={words} onChange={e => setWords(e.target.value)} placeholder={'Kirchhoff\nMOSFET\nkirk off => Kirchhoff'} />
      <button className="ghost" onClick={() => void saveWords()}>Save words</button>
    </details>
    {message && <p className="hint">{message}</p>}
    {error && <p className="error-text">{error}</p>}
  </Card>
}
