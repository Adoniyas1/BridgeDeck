import { useMemo, useState } from 'react'
import { Play, X } from 'lucide-react'
import { isTauri, pythonRun, type PythonRun } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { pathOf, plot, ticks } from './plot'

const COLORS = ['#60a5fa', '#f87171', '#4ade80', '#facc15', '#c084fc', '#2dd4bf', '#fb923c', '#f472b6']
const W = 560, H = 300, PAD = 34

const label = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(0) : String(Number(v.toPrecision(4))))

/** A graph block's plot: grid, axes, each function in its colour, and a legend. */
export function PlotView({ text, onClick }: { text: string; onClick?: () => void }) {
  const p = useMemo(() => plot(text), [text])
  const w = W - PAD - 14, h = H - 22
  const sx = (v: number) => PAD + ((v - p.x[0]) / (p.x[1] - p.x[0])) * w
  const sy = (v: number) => h - ((v - p.y[0]) / (p.y[1] - p.y[0])) * h
  return <div className={`notes-graph${onClick ? ' clickable' : ''}`} onClick={onClick} title={onClick ? 'Edit the graph' : undefined}>
    {p.curves.length > 0 && <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={p.curves.map(c => `${c.name} = ${c.source}`).join(', ')}>
      <defs><clipPath id="graph-clip"><rect x={0} y={0} width={w} height={h} /></clipPath></defs>
      {ticks(p.x[0], p.x[1]).map(v => <g key={`x${v}`}><line x1={sx(v)} y1={0} x2={sx(v)} y2={h} className={v === 0 ? 'axis' : 'grid'} /><text x={sx(v)} y={h + 14} textAnchor="middle">{label(v)}</text></g>)}
      {ticks(p.y[0], p.y[1], 6).map(v => <g key={`y${v}`}><line x1={PAD} y1={sy(v)} x2={PAD + w} y2={sy(v)} className={v === 0 ? 'axis' : 'grid'} /><text x={PAD - 4} y={sy(v) + 3} textAnchor="end">{label(v)}</text></g>)}
      <g clipPath="url(#graph-clip)" transform={`translate(${PAD},0)`}>
        {p.curves.map((c, i) => <path key={c.name + i} d={pathOf(c, p, w, h)} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={2} />)}
      </g>
    </svg>}
    {p.curves.length > 0 && <div className="notes-graph-legend">{p.curves.map((c, i) => <span key={c.name + i}><i style={{ background: COLORS[i % COLORS.length] }} />{c.name} = {c.source}</span>)}</div>}
    {p.errors.map(e => <p key={e} className="error-text">{e}</p>)}
    {!p.curves.length && !p.errors.length && <p className="hint">Write a function per line, like <code>y = sin(x)</code> or <code>f(x) = x^2 - 2x</code>, and optionally <code>x: -5..5</code> or <code>y: -2..2</code>.</p>}
  </div>
}

/** A Python cell's Run button and what it printed, its error and its charts. Output stays until
 *  the next run (it isn't saved in the note). */
export function PythonOutput({ code }: { code: string }) {
  const [result, setResult] = useState<PythonRun | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  async function run() {
    setRunning(true); setError('')
    try { setResult(await pythonRun(code)) } catch (e) { setResult(null); setError(errorText(e, 'Python didn’t run')) } finally { setRunning(false) }
  }
  return <div className="notes-python">
    <div className="notes-python-bar">
      <button className="secondary" disabled={running || !code.trim() || !isTauri()} onClick={() => void run()}><Play size={13} />{running ? 'Running…' : 'Run'}</button>
      {result && <small>{result.version} · {result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(1)} s`}{result.ok ? '' : result.timedOut ? ' · stopped' : ' · error'}</small>}
      {(result || error) && <button className="notes-icon" title="Clear the output" onClick={() => { setResult(null); setError('') }}><X size={13} /></button>}
    </div>
    {error && <p className="error-text">{error}</p>}
    {result && (result.stdout || result.stderr) && <pre className="notes-python-out">{result.stdout}{result.stderr && <span className="err">{result.stderr}</span>}</pre>}
    {result?.images.map((img, i) => <img key={i} className="notes-python-img" alt={`Chart ${i + 1}`} src={`data:image/png;base64,${img}`} />)}
  </div>
}
