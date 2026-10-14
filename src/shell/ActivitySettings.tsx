import { useEffect, useMemo, useState } from 'react'
import { Activity, ClipboardCopy, Cpu, FolderOpen, OctagonX, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { activityClear, activityRead, hardwareInfo, isTauri, openPath, safetySet, safetyStatus, safetyStopAi, type ActivityLog, type Hardware, type SafetySettings, type SafetyStatus } from '../lib/bridge'
import { setNotice } from '../core/notice'
import { errorText } from '../core/util'
import { Card, SectionTitle, Toggle } from '../ui'
import { version } from '../../package.json'

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
  return <><SafetyCard /><ActivityCard /></>
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
