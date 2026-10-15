import { useEffect, useMemo, useState } from 'react'
import { Activity, ClipboardCopy, Cpu, FolderOpen, OctagonX, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { activityClear, activityRead, aiSpeedLog, hardwareInfo, isTauri, openPath, safetySet, safetyStatus, safetyStopAi, type ActivityLog, type Hardware, type SafetySettings, type SafetyStatus } from '../lib/bridge'
import { setNotice } from '../core/notice'
import { errorText } from '../core/util'
import { Card, SectionTitle, Toggle } from '../ui'
import { version } from '../../package.json'
import { parseShareChanges, parseSpeed, type ShareChange, type SpeedSample } from './aiSpeed'

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`

export type Filter = 'all' | 'problems' | 'crashes'

/** The log's entries (each with its continuation lines) that pass the filter and search. */
export function filterLog(text: string, filter: Filter, query: string): string[] {
  const entries: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('[') || !entries.length) entries.push(line)
    else entries[entries.length - 1] += `\n${line}`
  }
  const q = query.trim().toLowerCase()
  return entries.filter(e => e.trim()).filter(e => {
    const kind = /^\[[^\]]+\]\s+(\w+)/.exec(e)?.[1] ?? 'INFO'
    if (filter === 'crashes' && kind !== 'CRASH') return false
    if (filter === 'problems' && kind === 'INFO') return false
    return !q || e.toLowerCase().includes(q)
  })
}

/** Settings → Activity & safety: this computer's memory and graphics card, the safety stop that
 *  stops the AI models before they freeze the computer, and the log of what BridgeDeck has done. */
export default function ActivitySettings() {
  if (!isTauri()) return <Card><p className="hint">The activity log and safety stop are in the BridgeDeck app.</p></Card>
  return <><SafetyCard /><AiSpeedCard /><ActivityCard /></>
}

const W = 600, H = 170, L = 36, R = 8, T = 10, B = 22

/** Each answer's speed (tokens per second), last 120 in order, with where the GPU share changed. */
function AiSpeedCard() {
  const [data, setData] = useState<{ samples: SpeedSample[]; changes: ShareChange[] } | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const load = () => void aiSpeedLog().then(l => setData({ samples: parseSpeed(l.speed).slice(-120), changes: parseShareChanges(l.activity) })).catch(() => setData({ samples: [], changes: [] }))
  useEffect(load, [])
  if (!data) return null
  const { samples } = data
  const max = Math.max(5, ...samples.map(s => s.tps)) * 1.1
  const step = Math.ceil(max / 4 / 5) * 5
  const x = (i: number) => L + (samples.length < 2 ? (W - L - R) / 2 : (i * (W - L - R)) / (samples.length - 1))
  const y = (v: number) => T + (H - T - B) * (1 - v / (step * 4))
  // A share change is drawn before the first answer after it.
  const marks = data.changes.flatMap(c => { const i = samples.findIndex(s => s.at >= c.at); return i > 0 ? [{ ...c, i }] : [] })
  const avg = samples.length ? samples.reduce((n, s) => n + s.tps, 0) / samples.length : 0
  const h = hover !== null ? samples[hover] : null
  const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return <Card>
    <SectionTitle title="AI speed" subtitle={samples.length ? `Tokens per second for Mimir's last ${samples.length} answer${samples.length === 1 ? '' : 's'} on local models · average ${avg.toFixed(1)}` : 'How fast Mimir answers on local models'} />
    {samples.length < 2 ? <p className="hint">Nothing yet: each answer from a local model (llama.cpp, llama-swap) is timed and shows here, with the moments the load watch or auto-tune changed how much runs on the GPU.</p> : <>
      <div className="ai-speed">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tokens per second, last ${samples.length} answers`}
          onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(samples.length - 1, Math.round(((px - L) / (W - L - R)) * (samples.length - 1))))) }}
          onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3, 4].map(k => <g key={k}>
            <line className="ai-speed__grid" x1={L} x2={W - R} y1={y(k * step)} y2={y(k * step)} />
            <text className="ai-speed__tick" x={L - 6} y={y(k * step) + 3} textAnchor="end">{k * step}</text>
          </g>)}
          {marks.map(m => <g key={m.at}>
            <line className="ai-speed__mark" x1={(x(m.i - 1) + x(m.i)) / 2} x2={(x(m.i - 1) + x(m.i)) / 2} y1={T} y2={H - B} />
            <text className="ai-speed__tick" x={(x(m.i - 1) + x(m.i)) / 2 + 3} y={T + 8}>{m.share}% GPU</text>
          </g>)}
          <polyline className="ai-speed__line" points={samples.map((s, i) => `${x(i)},${y(s.tps)}`).join(' ')} />
          {h && hover !== null && <>
            <line className="ai-speed__cross" x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} />
            <circle className="ai-speed__dot" cx={x(hover)} cy={y(h.tps)} r={4} />
          </>}
          <text className="ai-speed__tick" x={L} y={H - 6}>{when(samples[0].at)}</text>
          <text className="ai-speed__tick" x={W - R} y={H - 6} textAnchor="end">{when(samples[samples.length - 1].at)}</text>
        </svg>
        {h && hover !== null && <div className="ai-speed__tip" style={{ left: `${(x(hover) / W) * 100}%` }}><strong>{h.tps.toFixed(1)} tokens/s</strong><span>{h.model} · {h.tokens} tokens</span><span>{when(h.at)}</span></div>}
      </div>
      {marks.length > 0 && <p className="hint">Dashed lines: the GPU share changed ({marks.map(m => `${m.share}%: ${m.why.toLowerCase()}`).join('; ')}).</p>}
    </>}
    <div className="actions"><button className="secondary" onClick={load}><RefreshCw size={14} /> Refresh</button></div>
  </Card>
}

function SafetyCard() {
  const [status, setStatus] = useState<SafetyStatus | null>(null)
  const [hw, setHw] = useState<Hardware | null>(null)
  const load = () => void safetyStatus().then(setStatus).catch(() => undefined)
  useEffect(() => {
    load()
    void hardwareInfo().then(setHw).catch(() => undefined)
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [])
  if (!status) return null
  const s = status.settings
  const save = (patch: Partial<SafetySettings>) => void safetySet({ ...s, ...patch }).then(load).catch(e => setNotice(errorText(e, 'Couldn’t save that')))
  const vram = hw?.gpus.find(g => !g.shared)
  return <Card>
    <SectionTitle title="Safety stop" subtitle="Stops the AI models before they freeze the computer" action={<ShieldAlert size={18} />} />
    {hw && <div className="safety-hw">
      <span><Cpu size={14} /> <strong>RAM</strong> {gb(hw.ramTotal)} · {status.memoryUsedPercent}% in use</span>
      {vram && <span><strong>VRAM</strong> {gb(vram.totalBytes)} on {vram.name}{status.vramUsedPercent !== null ? ` · ${status.vramUsedPercent}% in use` : ''}</span>}
      {hw.gpus.filter(g => g.shared).map(g => <span key={g.name}><strong>GPU</strong> {g.name}</span>)}
      {!hw.gpus.length && <span className="hint">No graphics card memory found{navigator.userAgent.includes('Windows') ? ' (NVIDIA cards need their driver for this)' : ''}.</span>}
      <span className={status.aiRunning ? 'safety-ai on' : 'safety-ai'}>{status.aiRunning ? 'AI models running' : 'No AI models running'}</span>
    </div>}
    <Toggle checked={s.enabled} onChange={enabled => save({ enabled })} label="Watch the computer and stop the AI models when it’s about to run out of memory or freezes" />
    {s.enabled && <div className="safety-grid">
      <label>Stop them when RAM is <select value={s.memoryPercent} onChange={e => save({ memoryPercent: Number(e.target.value) })}>{[85, 90, 94, 97].map(p => <option key={p} value={p}>{p}% full</option>)}</select></label>
      <label>or graphics memory is <select value={s.vramPercent} onChange={e => save({ vramPercent: Number(e.target.value) })}>{[95, 98, 100].map(p => <option key={p} value={p}>{p}% full</option>)}</select></label>
    </div>}
    {s.enabled && <Toggle checked={s.closeApp} onChange={closeApp => save({ closeApp })} label="If stopping the models isn’t enough, close BridgeDeck too" />}
    <p className="hint">Before that, Mimir moves more of each model onto the CPU when the computer starts struggling (Mimir → Settings → Model servers → GPU use). A freeze with memory nearly full stops the models at once. The models can be started again from Mimir.</p>
    <div className="actions">
      <button className="secondary" onClick={() => void safetyStopAi().then(n => { setNotice(n ? `Stopped the AI models (${n} program${n === 1 ? '' : 's'}).` : 'No AI models were running.'); load() })}><OctagonX size={16} />Stop the AI models now</button>
    </div>
    {status.lastStop && <p className="hint">Last stepped in: {status.lastStop}</p>}
  </Card>
}

function ActivityCard() {
  const [log, setLog] = useState<ActivityLog | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [live, setLive] = useState(true)
  const load = () => void activityRead().then(setLog).catch(() => undefined)
  useEffect(() => {
    load()
    if (!live) return
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [live])
  const entries = useMemo(() => filterLog(log?.text ?? '', filter, query), [log, filter, query])
  const counts = useMemo(() => ({ problems: filterLog(log?.text ?? '', 'problems', '').length, crashes: filterLog(log?.text ?? '', 'crashes', '').length }), [log])

  async function copy() {
    const report = [`BridgeDeck ${version} activity, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, `System: ${navigator.userAgent}`, '', ...filterLog(log?.text ?? '', filter, query).slice(-400), '', log?.mimir ?? ''].join('\n')
    try { await navigator.clipboard.writeText(report); setNotice('Activity copied. Paste it into your chat with Claude.') } catch (e) { setNotice(errorText(e, 'Couldn’t copy it')) }
  }

  return <Card>
    <SectionTitle title="Activity" subtitle={`What BridgeDeck has been doing · ${counts.problems} problem${counts.problems === 1 ? '' : 's'}, ${counts.crashes} crash${counts.crashes === 1 ? '' : 'es'}`} action={<Activity size={18} />} />
    <div className="activity-tools">
      <div className="logic-view" role="tablist" aria-label="Show">
        {([['all', 'Everything'], ['problems', 'Problems'], ['crashes', 'Crashes']] as const).map(([id, title]) =>
          <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{title}</button>)}
      </div>
      <input type="search" placeholder="Search the log" value={query} onChange={e => setQuery(e.target.value)} />
      <button className={`ghost${live ? ' active' : ''}`} onClick={() => setLive(v => !v)} title="Keep the log up to date">{live ? 'Live' : 'Paused'}</button>
      <button className="ghost" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
    </div>
    <div className="activity-log" role="log">
      {entries.length ? entries.slice(-500).reverse().map((e, i) => {
        const kind = /^\[[^\]]+\]\s+(\w+)/.exec(e)?.[1]?.toLowerCase() ?? 'info'
        return <pre key={i} className={`activity-entry ${kind}`}>{e}</pre>
      }) : <p className="hint">{query || filter !== 'all' ? 'Nothing matches.' : 'Nothing logged yet.'}</p>}
    </div>
    {log?.mimir && <details className="activity-mimir"><summary>Mimir’s log (load watch, crashes)</summary><pre>{log.mimir}</pre></details>}
    <div className="actions">
      <button className="secondary" onClick={() => void copy()}><ClipboardCopy size={16} />Copy</button>
      {log?.path && <button className="secondary" onClick={() => void openPath(log.path.replace(/[\\/][^\\/]*$/, '')).catch(() => undefined)}><FolderOpen size={16} />Folder</button>}
      <button className="secondary" onClick={() => { if (window.confirm('Clear the activity log on this computer?')) void activityClear().then(load).catch(e => setNotice(errorText(e, 'Couldn’t clear it'))) }}><Trash2 size={16} />Clear</button>
    </div>
    <p className="hint">Newest first. Starts and closes, the computer’s hardware, actions (saving, sending, running code…), tabs opened, anything that failed or was slow, the safety stop, and every error and crash. Only what happened: never what you typed, sent or saved.</p>
  </Card>
}
