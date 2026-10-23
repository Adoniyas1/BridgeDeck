import { useMemo, useState } from 'react'
import { Play, X } from 'lucide-react'
import { isTauri, pythonRun, type PythonRun } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { pathOf, plot, ticks } from './plot'
import { formatQuantity, runLines } from '../../lib/expr'
import { parseNetlist, runChecks, solve } from '../../lib/mna'
import { aiAllowed, examOn } from '../../core/exam'
import { askMimir } from '../mimir'

/** Mimir is asked about the first wrong step only, and for a hint: what changed wrongly, not the
 *  rest of the working. */
const stepPrompt = (steps: string[]) => [
  'Here is my working, one step per line (lines starting with "=" follow from the line above). BridgeDeck checked it and the last step is not equal to the one before it:',
  '```', ...steps, '```',
  'Point out what went wrong in that last step only, as a hint, without doing the rest for me.',
].join('\n')

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

/** A calculator block: each line worked out with units and complex numbers, its answer beside it.
 *  "name = …" lines set names for the lines below. */
export function CalcView({ text, onClick }: { text: string; onClick?: () => void }) {
  // Checking steps is help too: off during an exam (sums still work).
  const exam = examOn()
  const lines = useMemo(() => runLines(text).map(l => exam && l.step ? { ...l, step: undefined, error: undefined, result: 'step checks are off during exam mode' } : l), [text, exam])
  const firstWrong = lines.findIndex(l => l.step === 'wrong')
  if (!text.trim()) return <p className="hint" onClick={onClick}>Write a sum per line, like <code>12V / 2.2kΩ</code>, <code>1k || 4.7k</code>, <code>5∠53° + 3-2j</code> or <code>yellow violet red gold</code>. A line starting with <code>=</code> is checked against the line above.</p>
  return <div className={`notes-calc${onClick ? ' clickable' : ''}`} onClick={onClick} title={onClick ? 'Edit the sums' : undefined}>
    {lines.map((l, i) => !l.line.trim() ? <div key={i} className="notes-calc-gap" />
      : <div key={i} className={`notes-calc-line${l.error ? ' bad' : ''}${l.step === 'ok' ? ' good' : ''}${!l.result && !l.error ? ' note' : ''}`}>
        <code>{l.line.trim()}</code>
        {(l.result || l.error) && <span>{l.error ?? (l.step ? l.result : l.name ? `${l.name} = ${l.result}` : `= ${l.result}`)}</span>}
        {l.step === 'wrong' && i === firstWrong && aiAllowed() && <button className="ghost" title="Mimir explains what went wrong in this step (a hint, not the answer)" onClick={e => { e.stopPropagation(); void askMimir(stepPrompt(lines.slice(0, i + 1).map(x => x.line.trim()).filter(Boolean)), true) }}>Why?</button>}
      </div>)}
  </div>
}

/** A circuit block: a SPICE-style netlist solved here (lib/mna.ts), with every node's voltage and
 *  part's current, and "?" lines checked. */
export function CircuitView({ text, onClick, checkOnly = false }: { text: string; onClick?: () => void; checkOnly?: boolean }) {
  const out = useMemo(() => {
    const net = parseNetlist(text)
    if (net.errors.length || !net.parts.length) return { net, error: net.errors.join(' · ') }
    try { return { net, sol: solve(net) } } catch (e) { return { net, error: e instanceof Error ? e.message : String(e) } }
  }, [text])
  if (!text.trim()) return <p className="hint" onClick={onClick}>A netlist, one part a line: <code>R1 in out 4.7k</code>, <code>V1 in 0 12V</code>, <code>C1 out 0 10uF</code>, <code>.ac 1kHz</code>, and <code>? V(out) = 3.4V</code> to check.</p>
  const checks = out.sol ? runChecks(out.net, out.sol, checkOnly) : []
  return <div className={`notes-circuit${onClick ? ' clickable' : ''}`} onClick={onClick} title={onClick ? 'Edit the circuit' : undefined}>
    <pre className="notes-circuit-net">{text}</pre>
    {out.error && <p className="error-text">{out.error}</p>}
    {out.sol && <>
      {checks.map((c, i) => <p key={i} className={`notes-circuit-check${c.right === true ? ' good' : c.right === false ? ' bad' : ''}`}><code>{c.what}</code> {c.message}</p>)}
      {checkOnly ? <p className="hint">Check-only: this course’s work is graded, so only your own values are checked (write them as ? V(node) = 3.4V).</p> : <details><summary>{out.sol.freq ? `At ${formatQuantity({ re: out.sol.freq, im: 0, dim: [0, 0, -1, 0] })}` : 'DC'}: every node and part</summary>
        <table className="notes-circuit-table"><tbody>
          {Object.entries(out.sol.voltages).map(([n, v]) => <tr key={`v${n}`}><td>V({n})</td><td>{formatQuantity({ ...v, dim: [2, 1, -3, -1] })}</td></tr>)}
          {Object.entries(out.sol.currents).map(([n, v]) => <tr key={`i${n}`}><td>I({n})</td><td>{formatQuantity({ ...v, dim: [0, 0, 0, 1] })}</td></tr>)}
        </tbody></table>
      </details>}
    </>}
  </div>
}
