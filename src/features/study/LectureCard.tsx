import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Download, Mic, Square, Trash2 } from 'lucide-react'
import { isTauri, modelsDownload, modelsRemove, modelsStatus, notesCreateMarkdown, type ModelsStatus } from '../../lib/bridge'
import { activateTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { notesStore, openNoteRequest } from '../notes/state'
import { clock, MODELS, toSamples, transcribe, transcriptMarkdown, type ModelId } from './lecture'
import { courseFolder } from './model'

const MODEL_KEY = 'bd-lecture-model'

/** Record a lecture and turn it into a note with timestamps. The audio is transcribed on this
 *  computer by Whisper (downloaded once); nothing leaves it. */
export function LectureCard({ course }: { course: string }) {
  const [status, setStatus] = useState<ModelsStatus | null>(null)
  const [model, setModel] = useState<ModelId>(() => { try { return (localStorage.getItem(MODEL_KEY) as ModelId) || 'fast' } catch { return 'fast' } })
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [started, setStarted] = useState(0)
  const [, tick] = useState(0)
  const [progress, setProgress] = useState(0)
  const [download, setDownload] = useState<{ mb: number; of: number } | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const recorder = useRef<MediaRecorder | null>(null)
  const parts = useRef<Blob[]>([])

  useEffect(() => {
    if (!isTauri()) return
    void modelsStatus().then(setStatus).catch(() => undefined)
    const stop = listen<{ model: string; mb: number; of: number }>('model-progress', e => setDownload({ mb: e.payload.mb, of: e.payload.of }))
    return () => { void stop.then(f => f()).catch(() => undefined) }
  }, [])
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

  async function start() {
    setError(''); setMessage('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } })
      const rec = new MediaRecorder(stream)
      parts.current = []
      rec.ondataavailable = e => { if (e.data.size) parts.current.push(e.data) }
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); void finish(new Blob(parts.current, { type: rec.mimeType })) }
      rec.start(10_000)
      recorder.current = rec
      setStarted(Date.now())
      setPhase('recording')
    } catch (e) {
      setError(`The microphone couldn’t be used: ${errorText(e, 'permission denied')}. Allow BridgeDeck to use the microphone in your system settings.`)
    }
  }

  async function finish(recording: Blob) {
    setPhase('transcribing'); setProgress(0)
    const when = new Date(started || Date.now())
    try {
      const segments = await transcribe(await toSamples(recording), model, setProgress)
      const title = `${course} — lecture ${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      const length = clock((Date.now() - when.getTime()) / 1000)
      const note = await notesCreateMarkdown(title, courseFolder(course), 'note', transcriptMarkdown(segments, `Recorded ${when.toLocaleString()} · about ${length} · transcribed on this computer (Whisper ${MODELS.find(m => m.id === model)!.label.toLowerCase()})`))
      notesStore.set(list => [note, ...list])
      setMessage(`Saved “${title}” in Notes.`)
      openNoteRequest.set(note.id)
      activateTab('notes')
    } catch (e) {
      setError(`Transcribing didn’t work: ${errorText(e, 'unknown error')}`)
    } finally {
      setPhase('idle')
    }
  }

  return <Card><SectionTitle title="Record a lecture" subtitle="Turned into a note with timestamps, on this computer" action={<Mic size={18} />} />
    {phase === 'recording' && <div className="lecture-live"><span className="lecture-dot" /> Recording {clock((Date.now() - started) / 1000)}
      <button className="danger" onClick={() => recorder.current?.stop()}><Square size={14} /> Stop and transcribe</button></div>}
    {phase === 'transcribing' && <p className="hint">Transcribing… {Math.round(progress * 100)}% (keep BridgeDeck open; an hour of audio takes a while)</p>}
    {phase === 'idle' && <>
      <div className="lecture-models">{MODELS.map(m => <label key={m.id}><input type="radio" name={`lecture-model-${course}`} checked={model === m.id} onChange={() => choose(m.id)} /> {m.label} <small>({m.size} MB{status?.models.includes(m.id) ? ', downloaded' : ''})</small></label>)}</div>
      {!isTauri() ? <p className="hint">Recording works in the BridgeDeck app.</p>
        : ready ? <div className="actions">
          <button onClick={() => void start()}><Mic size={15} /> Start recording</button>
          <button className="ghost" title="Remove this model from this computer" onClick={() => void modelsRemove(model).then(setStatus)}><Trash2 size={14} /></button>
        </div>
        : <div className="actions"><button disabled={!!download || status?.downloading} onClick={() => void getModel()}><Download size={15} />{download ? `Downloading… ${download.mb} of ~${download.of} MB` : `Download the ${MODELS.find(m => m.id === model)!.label.toLowerCase()} model (once)`}</button></div>}
      <p className="hint">Fast is quick and good for clear speech; Better is more accurate and takes about twice as long. Speech stays on this computer.</p>
    </>}
    {message && <p className="hint">{message}</p>}
    {error && <p className="error-text">{error}</p>}
  </Card>
}
