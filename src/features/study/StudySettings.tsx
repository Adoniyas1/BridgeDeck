import { useEffect, useState } from 'react'
import { GraduationCap, Languages, ShieldCheck } from 'lucide-react'
import { canvasApi, canvasFeed, isTauri, ocrLanguagesDownload, ocrLanguagesStatus } from '../../lib/bridge'
import { feedAssignments } from './canvas'
import { refreshCanvas } from './assignments'
import { setConfig, useConfig } from '../../core/config'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'

/** Languages text recognition can read in scanned books, besides English (codes Tesseract uses). */
export const OCR_LANGUAGES: Array<[string, string]> = [
  ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['rus', 'Russian'],
  ['ara', 'Arabic'], ['hin', 'Hindi'], ['chi_sim', 'Chinese (simplified)'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['amh', 'Amharic'],
]

/** Settings → Study: Canvas, exam mode's sites, and which languages scanned book pages are read in. */
export function StudySettings() {
  return <><CanvasSettings /><ExamSettings /><ScanSettings /></>
}

function ScanSettings() {
  const config = useConfig()
  const chosen = config.study.ocrLanguages
  const [have, setHave] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (isTauri()) void ocrLanguagesStatus().then(setHave).catch(() => undefined) }, [])

  async function toggle(code: string) {
    const next = chosen.includes(code) ? chosen.filter(c => c !== code) : [...chosen, code]
    setConfig(c => ({ ...c, study: { ...c.study, ocrLanguages: next } }))
    if (!next.includes(code) || have.includes(code) || !isTauri()) return
    setBusy(true); setError('')
    try { setHave(await ocrLanguagesDownload(next)) } catch (e) { setError(errorText(e, 'The language didn’t download')) } finally { setBusy(false) }
  }

  return <Card><SectionTitle title="Scanned books" subtitle="Languages text recognition reads, besides English" action={<Languages size={18} />} />
    <div className="ocr-languages">{OCR_LANGUAGES.map(([code, name]) => <label key={code}>
      <input type="checkbox" checked={chosen.includes(code)} disabled={busy} onChange={() => void toggle(code)} /> {name}{chosen.includes(code) && !have.includes(code) ? <small> (downloading…)</small> : null}
    </label>)}</div>
    {error && <p className="error-text">{error}</p>}
    <p className="hint">Each language is a few megabytes, downloaded once. They’re used for books indexed from now on.</p>
  </Card>
}

/** The Canvas connection: the calendar feed (assignments and due dates) and, for grades,
 *  announcements and what's been submitted, an access token. */
function CanvasSettings() {
  const config = useConfig()
  const canvas = config.canvas
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof canvas>) => setConfig(c => ({ ...c, canvas: { ...c.canvas, ...patch } }))

  async function test() {
    setBusy(true); setResult('')
    const lines: string[] = []
    try {
      if (canvas.feed.trim()) {
        try { lines.push(`Calendar feed: ${feedAssignments(await canvasFeed(canvas.feed.trim())).filter(a => a.kind !== 'event').length} assignments.`) } catch (e) { lines.push(`Calendar feed: ${errorText(e, 'didn’t load')}`) }
      }
      if (canvas.base.trim() && canvas.token.trim()) {
        try {
          const me = await canvasApi<{ name?: string }>(canvas.base, canvas.token, '/api/v1/users/self')
          lines.push(`Signed in to Canvas as ${me?.name ?? 'you'}.`)
        } catch (e) { lines.push(`Access token: ${errorText(e, 'didn’t work')}`) }
      }
      if (!lines.length) lines.push('Add the calendar feed link, or the Canvas address and an access token.')
      setResult(lines.join(' '))
      void refreshCanvas()
    } finally { setBusy(false) }
  }

  return <Card><SectionTitle title="Canvas" subtitle="Assignments, due dates, grades and announcements from your school’s Canvas" action={<GraduationCap size={18} />} />
    <label>Calendar feed link<input type="password" autoComplete="off" placeholder="https://school.instructure.com/feeds/calendars/user_….ics" value={canvas.feed} onChange={e => set({ feed: e.target.value.trim() })} /></label>
    <label>Canvas address<input placeholder="school.instructure.com" value={canvas.base} onChange={e => set({ base: e.target.value.trim() })} /></label>
    <label>Access token<input type="password" autoComplete="off" placeholder="Optional: for grades, announcements and what’s submitted" value={canvas.token} onChange={e => set({ token: e.target.value.trim() })} /></label>
    <label className="cal-setting">Remind me before a due date<select value={canvas.remindHours} onChange={e => set({ remindHours: Number(e.target.value) })}>
        {[0, 2, 6, 12, 24, 48, 72].map(h => <option key={h} value={h}>{h === 0 ? 'Only an hour before' : h < 24 ? `${h} hours (and an hour before)` : `${h / 24} day${h === 24 ? '' : 's'} (and an hour before)`}</option>)}
      </select></label>
    <div className="actions"><button disabled={busy || !isTauri()} onClick={() => void test()}>{busy ? 'Checking…' : 'Test and refresh'}</button></div>
    {result && <p className="hint">{result}</p>}
    <p className="hint"><strong>Calendar feed:</strong> in Canvas, open Calendar, then “Calendar Feed” at the bottom right, and copy the link. That’s enough for assignments and due dates.</p>
    <p className="hint"><strong>Access token</strong> (optional; some schools turn it off): Canvas → Account → Settings → “+ New Access Token”. It also shows grades, announcements and which assignments you’ve submitted. Both are kept in this computer’s password store, not in the settings file.</p>
  </Card>
}

/** Sites exam mode keeps closed in the Browser and TV. */
function ExamSettings() {
  const config = useConfig()
  const [text, setText] = useState(config.study.examBlock.join('\n'))
  useEffect(() => setText(config.study.examBlock.join('\n')), [config.study.examBlock])
  const save = () => {
    const sites = [...new Set(text.split(/[\s,]+/).map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean))].slice(0, 200)
    setConfig(c => ({ ...c, study: { ...c.study, examBlock: sites } }))
  }
  return <Card><SectionTitle title="Exam mode" subtitle="Sites kept closed in the Browser and TV while it’s on" action={<ShieldCheck size={18} />} />
    <textarea className="exam-sites" rows={5} value={text} onChange={e => setText(e.target.value)} onBlur={save} placeholder="youtube.com" />
    <p className="hint">One site per line; its subdomains are closed too. Start exam mode from a course in the Study tab. Only reminders notify while it’s on.</p>
  </Card>
}
