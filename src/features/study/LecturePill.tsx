import { useEffect, useState } from 'react'
import { HelpCircle, Square } from 'lucide-react'
import { activateTab } from '../../core/tabs'
import { useStore } from '../../core/store'
import { clock } from './lecture'
import { lectureJobStore, markLost, stopRecording } from './lectureJob'

/** A lecture being recorded or transcribed, shown over every tab (it keeps going while you work
 *  elsewhere): the time, "Lost here", Stop, and a click back to Study. */
export function LecturePill() {
  const job = useStore(lectureJobStore)
  const [, tick] = useState(0)
  useEffect(() => {
    if (job.phase !== 'recording') return
    const id = window.setInterval(() => tick(n => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [job.phase])
  if (job.phase === 'idle') return null
  return <div className={`lecture-pill lecture-pill--${job.phase}`} role="status">
    <button className="lecture-pill__what" title="Open Study" onClick={() => activateTab('study')}>
      {job.phase === 'recording' ? <><span className="lecture-dot" />{job.course} · {clock((Date.now() - job.started) / 1000)}</> : <>Transcribing {job.course} · {Math.round(job.progress * 100)}%</>}
    </button>
    {job.phase === 'recording' && <>
      <button className="ghost" title="Mark a moment you got lost, to come back to" onClick={markLost}><HelpCircle size={13} /></button>
      <button className="danger" title="Stop and transcribe" onClick={stopRecording}><Square size={13} /> Stop</button>
    </>}
  </div>
}
