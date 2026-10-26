import { convertFileSrc } from '@tauri-apps/api/core'
import { notesCreateMarkdown, studyLecturePut, studySaveLecture } from '../../lib/bridge'
import { examOn } from '../../core/exam'
import { createStore } from '../../core/store'
import { errorText } from '../../core/util'
import { notesStore } from '../notes/state'
import { clock, correctWords, lectureNoteMarkdown, listenInWindows, LiveTranscriber, LIVE_WINDOW, toSamples, transcribe, wordFixes, type ModelId, type Segment } from './lecture'
import { courseFolder, lectureLink } from './model'
import { openLecture } from './open'

/**
 * A lecture being recorded or transcribed. It runs here, not in the Lectures card, so it keeps going
 * whatever tab is open (and with Study closed) until it's stopped or done; the card and the pill at
 * the bottom of the window (LectureJobPill) only show it.
 */
export type LectureJob = {
  phase: 'idle' | 'recording' | 'transcribing'
  course: string
  started: number
  /** 0–1 while transcribing. */
  progress: number
  /** The live transcript while recording (the full pass at the end replaces it). */
  heard: Segment[]
  /** Moments marked "Lost here", in seconds from the start. */
  marks: number[]
  message: string
  error: string
  /** Bumped when a lecture is saved or transcribed, so lists reload. */
  saved: number
}

const IDLE: LectureJob = { phase: 'idle', course: '', started: 0, progress: 0, heard: [], marks: [], message: '', error: '', saved: 0 }
export const lectureJobStore = createStore<LectureJob>(IDLE)
const patch = (p: Partial<LectureJob>) => lectureJobStore.set(j => ({ ...j, ...p }))

let recorder: MediaRecorder | null = null
let live: { stop: () => void } | null = null

/** Starts recording a course's lecture. Throws (with a message to show) when it can't. */
export async function startRecording(course: string, model: ModelId, words: unknown, withLiveTranscript: boolean) {
  if (lectureJobStore.get().phase !== 'idle') throw new Error('A lecture is already being recorded or transcribed.')
  if (examOn()) throw new Error('Recording is off during exam mode.')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } })
  } catch (e) {
    throw new Error(`The microphone couldn’t be used: ${errorText(e, 'permission denied')}. Allow BridgeDeck to use the microphone in your system settings.`)
  }
  const rec = new MediaRecorder(stream)
  const parts: Blob[] = []
  const at = Date.now()
  rec.ondataavailable = e => { if (e.data.size) parts.push(e.data) }
  if (withLiveTranscript) {
    const fixes = wordFixes(words)
    const transcriber = new LiveTranscriber(model, s => patch({ heard: [...lectureJobStore.get().heard, ...correctWords(s, fixes)] }), m => patch({ message: `Live transcript stopped: ${m}` }))
    const stopListening = listenInWindows(stream, LIVE_WINDOW, (samples, offset) => { if (!examOn()) transcriber.push(samples, offset) })
    live = { stop: () => { stopListening(); transcriber.stop() } }
  }
  rec.onstop = () => {
    live?.stop(); live = null; recorder = null
    stream.getTracks().forEach(t => t.stop())
    void finishRecording(course, new Blob(parts, { type: rec.mimeType }), at, lectureJobStore.get().marks, model, words)
  }
  rec.start(10_000)
  recorder = rec
  lectureJobStore.set({ ...IDLE, saved: lectureJobStore.get().saved, phase: 'recording', course, started: at })
}

/** Stops the recording; it's then saved and transcribed. */
export function stopRecording() {
  if (recorder?.state === 'recording') recorder.stop()
}

/** Marks the moment you got lost, to come back to. */
export function markLost() {
  const job = lectureJobStore.get()
  if (job.phase !== 'recording') return
  const t = (Date.now() - job.started) / 1000
  patch({ marks: [...job.marks, t], message: `Marked ${clock(t)}.` })
}

function lectureName(at: number) {
  const when = new Date(at)
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} Lecture`
}

async function finishRecording(course: string, recording: Blob, at: number, marks: number[], model: ModelId, words: unknown) {
  try {
    // The audio is kept first, so a failed transcription loses nothing.
    const file = await studySaveLecture(course, lectureName(at), new Uint8Array(await recording.arrayBuffer()))
    patch({ saved: lectureJobStore.get().saved + 1 })
    await transcribeLecture(course, file, recording, at, marks, model, words)
  } catch (e) {
    patch({ phase: 'idle', error: `Saving the recording didn’t work: ${errorText(e, 'unknown error')}` })
  }
}

/** Transcribes a kept lecture file of the course. */
export async function transcribeLectureFile(course: string, file: string, at: number, model: ModelId, words: unknown) {
  const response = await fetch(convertFileSrc(`${course}/Lectures/${file}`, 'bdbook'))
  await transcribeLecture(course, file, await response.blob(), at, [], model, words)
}

/** Transcribes a recording, fixes the course's words, and saves the transcript beside it with a
 *  dated note linking to it. Runs until it's done, whatever tab is open. */
export async function transcribeLecture(course: string, file: string, audio: Blob, at: number, markers: number[], model: ModelId, words: unknown) {
  lectureJobStore.set(j => ({ ...j, phase: 'transcribing', course, progress: 0, error: '', message: '' }))
  try {
    const samples = await toSamples(audio)
    const length = clock(samples.length / 16000)
    const segments: Segment[] = correctWords(await transcribe(samples, model, progress => patch({ progress })), wordFixes(words))
    const when = new Date(at)
    const title = `${course} — lecture ${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    const note = await notesCreateMarkdown(title, courseFolder(course), 'note', lectureNoteMarkdown(when, length, segments, t => lectureLink(course, file, t)))
    notesStore.set(list => [note, ...list])
    await studyLecturePut(course, file, { segments, markers: markers.map(t => ({ t })), started: at, note: note.id })
    patch({ phase: 'idle', saved: lectureJobStore.get().saved + 1, message: `Transcribed “${file}” and made the note “${title}”.` })
    openLecture(course, file)
  } catch (e) {
    patch({ phase: 'idle', error: `Transcribing didn’t work: ${errorText(e, 'unknown error')}. The recording is kept; try again from the list.` })
  }
}
