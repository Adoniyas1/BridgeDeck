import { useState } from 'react'
import { CheckCircle2, CircleAlert, ClipboardCopy, ListChecks, Loader2, XCircle } from 'lucide-react'
import { ankiSelftest, arduinoStatus, isTauri, lectureToolStatus, mimirControl, solidcraftServe, solidcraftStatus } from '../lib/bridge'
import { errorText } from '../core/util'
import { Card, SectionTitle } from '../ui'
import { version } from '../../package.json'

type Result = { status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }
type Check = { id: string; label: string; run: () => Promise<Result> }

const ms = (t: number) => (t < 1000 ? `${Math.round(t)} ms` : `${(t / 1000).toFixed(1)} s`)
const timed = async <T,>(f: () => Promise<T>): Promise<[T, number]> => { const t = performance.now(); const v = await f(); return [v, performance.now() - t] }

/** Each feature run for real on this computer: the parts that couldn't be tried where they were
 *  built (a Mac's or a PC's own web view, compilers and downloads). */
const CHECKS: Check[] = [
  {
    id: 'cad', label: 'CAD: build a part (OpenCascade)',
    run: async () => {
      const [{ build }, { EXAMPLES }] = await Promise.all([import('../features/cad/kernel'), import('../features/cad/model')])
      const [r, t] = await timed(() => build(EXAMPLES[0].code, null))
      const triangles = r.parts.reduce((n, p) => n + p.faces.triangles.length / 3, 0)
      return { status: triangles > 30 ? 'ok' : 'fail', detail: `Built “${EXAMPLES[0].name}” in ${ms(t)} (${Math.round(triangles)} triangles).` }
    },
  },
  {
    id: 'solidcraft', label: 'CAD: SolidCraft (Fusion-style)',
    run: async () => {
      if (!isTauri()) return { status: 'warn', detail: 'Needs the BridgeDeck app.' }
      const st = await solidcraftStatus()
      if (!st.installed) return { status: 'warn', detail: `Not downloaded yet (${st.downloadMb} MB).`, fix: 'Open the CAD tab and press Download SolidCraft.' }
      const address = await solidcraftServe()
      // No CORS headers from the local server: an opaque answer still shows it's serving.
      await fetch(address, { mode: 'no-cors' })
      const gpu = 'gpu' in navigator
      return { status: 'ok', detail: `Version ${st.version}, served at ${address}, drawing with ${gpu ? 'WebGPU' : 'WebGL2 (this web view has no WebGPU)'}.` }
    },
  },
  {
    id: 'spice', label: 'Circuits: simulate with ngspice',
    run: async () => {
      const { simulate } = await import('../lib/spiceRun')
      const [r, t] = await timed(() => simulate('V1 in 0 PULSE(0 5 0 1n 1n 10m 20m)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 3m'))
      if (!r.result || r.result.kind !== 'time') return { status: 'fail', detail: r.problems.join(' · ') || 'No result.' }
      const res = r.result
      const out = res.traces.find(x => x.name === 'V(out)')
      const atTau = out?.values[res.x.values.findIndex(x => x >= 1e-3)] ?? NaN
      const right = Math.abs(atTau - 5 * (1 - Math.exp(-1))) < 0.15
      return { status: right ? 'ok' : 'fail', detail: `An RC step reached ${atTau.toFixed(2)} V at one time constant (theory 3.16 V), in ${ms(t)}.` }
    },
  },
  {
    id: 'split', label: 'Books: chapter files keep their sections',
    run: async () => {
      const [{ PDFDocument }, { splitPdf }, { pdfjs }] = await Promise.all([import('pdf-lib'), import('../lib/pdfwrite'), import('../features/study/pdf')])
      const book = await PDFDocument.create()
      for (let i = 0; i < 6; i++) book.addPage([200, 200])
      const bytes = await book.save()
      const [part] = await splitPdf(bytes.buffer.slice(0) as ArrayBuffer, [{ start: 3, end: 6 }], undefined, { outline: [{ title: '2 Signals', page: 3, items: [{ title: '2.1 Sine waves', page: 4, items: [] }] }] })
      const doc = await pdfjs.getDocument({ data: part, isEvalSupported: false }).promise
      const outline = (await doc.getOutline()) ?? []
      const labels = await doc.getPageLabels()
      void doc.destroy()
      const ok = outline[0]?.title === '2 Signals' && outline[0]?.items?.[0]?.title === '2.1 Sine waves' && labels?.[0] === '3'
      return { status: ok ? 'ok' : 'fail', detail: ok ? 'A split chapter kept its section and sub-section, and the book’s page numbers.' : 'The chapter file came back without its sections or page numbers.' }
    },
  },
  {
    id: 'kicad', label: 'Projects: KiCad viewer',
    run: async () => {
      const { loadKiCanvas } = await import('../features/projects/KiCadTab')
      await loadKiCanvas()
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;height:300px'
      const embed = document.createElement('kicanvas-embed')
      embed.setAttribute('controls', 'none')
      const source = document.createElement('kicanvas-source')
      source.setAttribute('name', 'check.kicad_sch')
      source.textContent = '(kicad_sch (version 20230121) (generator eeschema) (uuid "0b1c2e3a-0000-4000-8000-000000000001") (paper "A4"))'
      embed.appendChild(source)
      host.appendChild(embed)
      document.body.appendChild(host)
      try {
        for (let i = 0; i < 50 && !embed.hasAttribute('loaded'); i++) await new Promise(r => setTimeout(r, 200))
        return embed.hasAttribute('loaded') ? { status: 'ok', detail: 'KiCanvas loaded and drew a schematic.' } : { status: 'fail', detail: 'KiCanvas didn’t finish drawing in 10 s.', fix: 'This web view may lack WebGL 2: Report a problem below.' }
      } finally { host.remove() }
    },
  },
  {
    id: 'arduino', label: 'Arduino: build and simulate a sketch',
    run: async () => {
      const s = await arduinoStatus()
      if (!s.cli) return { status: 'warn', detail: 'arduino-cli isn’t set up yet.', fix: 'Code → Arduino → Set up Arduino (once; about 150 MB).' }
      if (!s.avr) return { status: 'warn', detail: `${s.version || 'arduino-cli'} is here, but not the Uno’s tools.`, fix: 'Code → Arduino → Set up Arduino.' }
      const { testArduino } = await import('../features/code/Compilers')
      const r = await testArduino()
      return r.ok ? { status: 'ok', detail: `Built a sketch with ${s.version || 'arduino-cli'} and ran it on the simulated Uno: ${r.detail.toLowerCase()}.` } : { status: 'fail', detail: r.detail }
    },
  },
  {
    id: 'ytdlp', label: 'Lectures from a link (yt-dlp)',
    run: async () => {
      const t = await lectureToolStatus()
      return t.path ? { status: 'ok', detail: `yt-dlp ${t.version} is installed (${t.path}).` } : { status: 'warn', detail: 'yt-dlp isn’t installed yet.', fix: 'A course’s Lectures card → From a link → Install yt-dlp.' }
    },
  },
  {
    id: 'anki', label: 'Flashcards: read Anki decks',
    run: async () => ({ status: 'ok', detail: await ankiSelftest() }),
  },
  {
    id: 'mimir', label: 'Mimir: its model and engine answer',
    run: async () => {
      const checks = await mimirControl<Array<{ label: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }>>('mimir:ai:check')
      const fail = checks.filter(c => c.status === 'fail'), warn = checks.filter(c => c.status === 'warn')
      const first = fail[0] ?? warn[0]
      return first ? { status: fail.length ? 'fail' : 'warn', detail: `${first.label}: ${first.detail}${fail.length + warn.length > 1 ? ` (and ${fail.length + warn.length - 1} more in Settings → AI → Test my AI setup)` : ''}`, fix: first.fix } : { status: 'ok', detail: `All ${checks.length} checks passed.` }
    },
  },
]

/** Settings → About: "Check new features", each tried for real here, with a report to copy. */
export function FeatureCheck() {
  const [results, setResults] = useState<Record<string, Result | 'running'>>({})
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)

  async function runAll() {
    setRunning(true); setResults({}); setCopied(false)
    for (const c of CHECKS) {
      setResults(r => ({ ...r, [c.id]: 'running' }))
      let out: Result
      try { out = await Promise.race([c.run(), new Promise<Result>((_, reject) => setTimeout(() => reject(new Error('It took over 3 minutes.')), 180_000))]) }
      catch (e) { out = { status: 'fail', detail: errorText(e, 'It failed') } }
      setResults(r => ({ ...r, [c.id]: out }))
    }
    setRunning(false)
  }

  const done = CHECKS.map(c => [c, results[c.id]] as const).filter((x): x is readonly [Check, Result] => !!x[1] && x[1] !== 'running')
  const report = [`BridgeDeck ${version} feature check, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, navigator.userAgent, '', ...done.map(([c, r]) => `${r.status.toUpperCase()}  ${c.label}: ${r.detail}${r.fix ? ` → ${r.fix}` : ''}`)].join('\n')
  const failed = done.filter(([, r]) => r.status === 'fail').length
  const toSetUp = done.filter(([, r]) => r.status === 'warn').length

  return <Card>
    <SectionTitle title="Check new features" subtitle="CAD, circuits, chapter files, KiCad, Arduino, lecture links, Anki and Mimir, each tried for real on this computer" action={<ListChecks size={18} />} />
    <div className="feature-checks">{CHECKS.map(c => {
      const r = results[c.id]
      return <div key={c.id} className={`feature-check ${r && r !== 'running' ? r.status : ''}`}>
        {r === 'running' ? <Loader2 size={14} className="spin" /> : !r ? <i className="feature-check-dot" /> : r.status === 'ok' ? <CheckCircle2 size={14} /> : r.status === 'warn' ? <CircleAlert size={14} /> : <XCircle size={14} />}
        <span className="grow"><strong>{c.label}</strong>{r && r !== 'running' && <small>{r.detail}{r.fix ? <><br />{r.fix}</> : null}</small>}</span>
      </div>
    })}</div>
    <div className="actions">
      <button disabled={running || !isTauri()} onClick={() => void runAll()}>{running ? <Loader2 size={14} className="spin" /> : <ListChecks size={14} />} {running ? 'Checking…' : done.length ? 'Check again' : 'Run the checks'}</button>
      {done.length > 0 && !running && <button className="secondary" onClick={() => void navigator.clipboard.writeText(report).then(() => setCopied(true))}><ClipboardCopy size={14} /> {copied ? 'Copied' : 'Copy the report'}</button>}
    </div>
    {!isTauri() && <p className="hint">The checks run in the BridgeDeck app.</p>}
    {done.length === CHECKS.length && !running && <p className="hint">{failed ? `${failed} didn’t work: copy the report and paste it to Claude (or use Report a problem above).` : toSetUp ? `Everything that’s set up works; ${toSetUp} need${toSetUp === 1 ? 's' : ''} setting up (see above).` : 'Everything works on this computer.'}</p>}
  </Card>
}
