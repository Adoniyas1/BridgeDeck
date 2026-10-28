import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { engineering } from '../../lib/expr'
import { cutoff, shownTraces, type SpiceResult, type Trace } from '../../lib/spice'

const COLORS = ['#60a5fa', '#f87171', '#4ade80', '#facc15', '#c084fc', '#2dd4bf']
const W = 560, H = 240, L = 58, R = 12, T = 10, B = 26

const unitOf = (name: string) => name.startsWith('V(') ? 'V' : name.startsWith('I(') ? 'A' : ''

function niceTicks(lo: number, hi: number, count = 6): number[] {
  if (!(hi > lo)) return [lo]
  const step0 = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= step0) ?? step0
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return out
}

/** One chart: traces over x (log x for frequency), with a legend that hides and shows them. */
function Chart({ x, xUnit, log, traces, yUnit, yLabel, marker }: { x: number[]; xUnit: string; log: boolean; traces: Trace[]; yUnit: string; yLabel?: string; marker?: { at: number; text: string } | null }) {
  const [hidden, setHidden] = useState<string[]>([])
  const shown = traces.filter(t => !hidden.includes(t.name))
  const fx = (v: number) => (log ? Math.log10(Math.max(v, 1e-30)) : v)
  const xs = x.map(fx)
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const all = shown.flatMap(t => t.values).filter(Number.isFinite)
  let [y0, y1] = all.length ? [Math.min(...all), Math.max(...all)] : [0, 1]
  if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1 }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad
  const w = W - L - R, h = H - T - B
  const sx = (v: number) => L + ((fx(v) - x0) / (x1 - x0 || 1)) * w
  const sy = (v: number) => T + h - ((v - y0) / (y1 - y0)) * h
  const xticks = log ? Array.from({ length: Math.floor(x1) - Math.ceil(x0) + 1 }, (_, i) => 10 ** (Math.ceil(x0) + i)) : niceTicks(x0, x1)
  return <div className="spice-chart">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${shown.map(t => t.name).join(', ')} over ${xUnit === 'Hz' ? 'frequency' : 'time'}`}>
      {niceTicks(y0, y1, 7).map(v => <g key={`y${v}`}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className="spice-grid" /><text x={L - 6} y={sy(v) + 4} textAnchor="end">{engineering(v, yUnit, 3)}</text></g>)}
      {xticks.map(v => <g key={`x${v}`}><line y1={T} y2={T + h} x1={sx(v)} x2={sx(v)} className="spice-grid" /><text x={sx(v)} y={H - 8} textAnchor="middle">{engineering(v, xUnit, 3)}</text></g>)}
      {yLabel && <text x={12} y={T + h / 2} transform={`rotate(-90 12 ${T + h / 2})`} textAnchor="middle">{yLabel}</text>}
      {marker && <g><line x1={sx(marker.at)} x2={sx(marker.at)} y1={T} y2={T + h} className="spice-marker" /><text x={sx(marker.at) + 4} y={T + 12}>{marker.text}</text></g>}
      {shown.map(t => {
        const color = COLORS[traces.indexOf(t) % COLORS.length]
        const d = t.values.map((v, i) => Number.isFinite(v) ? `${i ? 'L' : 'M'}${sx(x[i]).toFixed(1)},${sy(v).toFixed(1)}` : '').join('')
        return <path key={t.name} d={d} fill="none" stroke={color} strokeWidth={1.8} />
      })}
    </svg>
    <div className="spice-legend">{traces.map((t, i) => <button key={t.name} className={hidden.includes(t.name) ? 'off' : ''} onClick={e => { e.stopPropagation(); setHidden(hh => hh.includes(t.name) ? hh.filter(n => n !== t.name) : [...hh, t.name]) }}><i style={{ background: COLORS[i % COLORS.length] }} />{t.name}</button>)}</div>
  </div>
}

/** A circuit run in ngspice: voltages and currents over time, a Bode plot for a frequency sweep, or
 *  the operating point; with what ngspice warned about. */
export function SpiceView({ text, onClick, checkOnly }: { text: string; onClick?: () => void; checkOnly: boolean }) {
  const [state, setState] = useState<{ result: SpiceResult | null; problems: string[]; busy: boolean }>({ result: null, problems: [], busy: true })
  useEffect(() => {
    if (checkOnly) return
    let live = true
    setState(s => ({ ...s, busy: true }))
    const timer = window.setTimeout(() => {
      void import('../../lib/spiceRun').then(m => m.simulate(text)).then(r => { if (live) setState({ ...r, busy: false }) })
        .catch(e => { if (live) setState({ result: null, problems: [e instanceof Error ? e.message : String(e)], busy: false }) })
    }, 400)
    return () => { live = false; window.clearTimeout(timer) }
  }, [text, checkOnly])
  const r = state.result
  const traces = useMemo(() => (r && r.kind !== 'point' ? shownTraces(r.traces) : []), [r])
  // Volts and amps never share an axis: currents get their own chart (and stay out of Bode plots
  // unless they're all there is).
  const volts = traces.filter(t => unitOf(t.name) === 'V')
  const amps = traces.filter(t => unitOf(t.name) === 'A')
  const bode = volts.length ? volts : amps
  const phases = useMemo(() => (r && r.kind === 'freq' ? shownTraces(r.phases).filter(t => bode.some(b => b.name === t.name)) : []), [r, bode])
  const fc = useMemo(() => {
    if (!r || r.kind !== 'freq') return null
    const out = bode.find(t => t.name === 'V(out)') ?? bode[bode.length - 1]
    return out ? cutoff(r.x.values, out.values) : null
  }, [r, bode])

  return <div className={`notes-circuit${onClick ? ' clickable' : ''}`} onClick={onClick} title={onClick ? 'Edit the circuit' : undefined}>
    <pre className="notes-circuit-net">{text}</pre>
    {checkOnly ? <p className="hint">Simulation is off for this course: its work is graded.</p> : <>
      {state.busy && <p className="hint"><Loader2 size={13} className="spin" /> Simulating with ngspice…</p>}
      {state.problems.map((p, i) => <p key={i} className="error-text">{p}</p>)}
      {(r?.kind === 'time' || r?.kind === 'sweep') && <>
        {volts.length > 0 && <Chart x={r.x.values} xUnit={r.kind === 'time' ? 's' : unitOf(r.x.name)} log={false} traces={volts} yUnit="V" />}
        {amps.length > 0 && <Chart x={r.x.values} xUnit={r.kind === 'time' ? 's' : unitOf(r.x.name)} log={false} traces={amps} yUnit="A" />}
      </>}
      {r?.kind === 'freq' && <>
        <Chart x={r.x.values} xUnit="Hz" log traces={bode} yUnit="" yLabel="Gain (dB)" marker={fc ? { at: fc, text: `−3 dB at ${engineering(fc, 'Hz', 3)}` } : null} />
        <Chart x={r.x.values} xUnit="Hz" log traces={phases} yUnit="" yLabel="Phase (°)" />
      </>}
      {r?.kind === 'point' && <table className="notes-circuit-table"><tbody>
        {r.values.map(v => <tr key={v.name}><td>{v.name}</td><td>{engineering(v.value, unitOf(v.name), 4)}</td></tr>)}
      </tbody></table>}
    </>}
  </div>
}
