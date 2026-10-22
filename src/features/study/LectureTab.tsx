import { useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { HelpCircle, Sparkles } from 'lucide-react'
import { studyLectureGet, studyLecturePut, type LectureSidecar } from '../../lib/bridge'
import type { DynamicTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import { askMimir } from '../mimir'
import { clock } from './lecture'
import { lectureSummaryPrompt } from './lectureMimir'

/** A lecture recording with its transcript: a line plays from its time, the line being said is
 *  marked, "?" notes a moment to come back to, and photos from class sit at their time. */
export default function LectureTab({ tab, active }: { tab: DynamicTab; active: boolean }) {
  const course = String(tab.params?.course ?? ''), file = String(tab.params?.file ?? '')
  const t = String(tab.params?.t ?? '0'), at = String(tab.params?.at ?? '')
  const audio = useRef<HTMLAudioElement>(null)
  const [data, setData] = useState<LectureSidecar | null>(null)
  const [now, setNow] = useState(0)
  const [error, setError] = useState('')
  const src = useMemo(() => convertFileSrc(`${course}/Lectures/${file}`, 'bdbook'), [course, file])

  useEffect(() => { void studyLectureGet(course, file).then(setData).catch(e => setError(errorText(e, 'Couldn’t read the transcript'))) }, [course, file])
  // Opened from a link: start at its time.
  useEffect(() => { const el = audio.current; if (el && Number(t) > 0) { el.currentTime = Number(t); if (active) void el.play().catch(() => undefined) } }, [t, at])
  useEffect(() => { if (!active) audio.current?.pause() }, [active])

  const segments = data?.segments ?? []
  const markers = data?.markers ?? []
  const photos = data?.photos ?? []
  const playing = segments.findIndex(s => now >= s.start && now < s.end)
  const seek = (time: number) => { const el = audio.current; if (el) { el.currentTime = time; void el.play().catch(() => undefined) } }

  async function mark() {
    const time = audio.current?.currentTime ?? 0
    const next = { ...(data ?? {}), markers: [...markers, { t: time }].sort((a, b) => a.t - b.t) }
    setData(next)
    try { await studyLecturePut(course, file, next) } catch (e) { setError(errorText(e, 'Couldn’t save the mark')) }
  }
  async function unmark(time: number) {
    const next = { ...(data ?? {}), markers: markers.filter(m => m.t !== time) }
    setData(next)
    try { await studyLecturePut(course, file, next) } catch (e) { setError(errorText(e, 'Couldn’t save')) }
  }

  // Rows in time order: what was said, "?" marks and photos.
  const rows = useMemo(() => [
    ...segments.map((s, i) => ({ t: s.start, kind: 'said' as const, i, text: s.text })),
    ...markers.map(m => ({ t: m.t, kind: 'mark' as const, i: -1, text: m.note ?? '' })),
    ...photos.map(p => ({ t: p.t, kind: 'photo' as const, i: -1, text: p.file })),
  ].sort((a, b) => a.t - b.t), [segments, markers, photos])

  return <div className="lecture-tab">
    <div className="lecture-bar">
      <audio ref={audio} src={src} controls preload="metadata" onTimeUpdate={e => setNow(e.currentTarget.currentTime)} />
      <button className="ghost" title="Mark this moment to come back to" onClick={() => void mark()}><HelpCircle size={15} />Lost here</button>
      <button className="ghost" title="Summary, key terms and cards from Mimir (the cards wait for you to add)" onClick={() => void askMimir(lectureSummaryPrompt(course, file), true, course)}><Sparkles size={15} />Summarise</button>
    </div>
    {error && <p className="error-text">{error}</p>}
    {markers.length > 0 && <div className="lecture-markers">{markers.map(m => <span key={m.t}><button className="ghost" onClick={() => seek(m.t)}>? {clock(m.t)}</button><button className="ghost" title="Resolved" onClick={() => void unmark(m.t)}>×</button></span>)}</div>}
    <div className="lecture-transcript">
      {!segments.length && <p className="hint">{data === null ? 'No transcript yet: transcribe it from the course’s Lectures card.' : 'Nothing was heard in this recording.'}</p>}
      {rows.map((r, k) => r.kind === 'said'
        ? <p key={k} className={r.i === playing ? 'now' : ''} onClick={() => seek(r.t)}><span className="lecture-time">{clock(r.t)}</span>{r.text}</p>
        : r.kind === 'mark' ? <p key={k} className="lecture-mark" onClick={() => seek(r.t)}><span className="lecture-time">{clock(r.t)}</span>? Lost here{r.text ? `: ${r.text}` : ''}</p>
        : <figure key={k} className="lecture-photo" onClick={() => seek(r.t)}><img src={convertFileSrc(`${course}/${r.text}`, 'bdbook')} alt={`Photo at ${clock(r.t)}`} loading="lazy" /><figcaption>{clock(r.t)}</figcaption></figure>)}
    </div>
  </div>
}
