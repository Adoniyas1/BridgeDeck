import { useEffect, useState } from 'react'
import { isTauri, safetyStatus, type SafetyStatus } from '../lib/bridge'
import { openSettings } from '../core/settingsNav'

const level = (v: number, stopAt: number) => (v >= stopAt - 4 ? 'bad' : v >= stopAt - 14 ? 'warn' : 'ok')

/** How full memory and the graphics card are, at a glance (the safety stop's own readings). Click
 *  for Settings → Activity & safety. */
export function SystemMeter() {
  const [s, setS] = useState<SafetyStatus | null>(null)
  useEffect(() => {
    if (!isTauri()) return
    let live = true
    const read = () => { if (!document.hidden) void safetyStatus().then(v => { if (live) setS(v) }).catch(() => undefined) }
    read()
    const timer = window.setInterval(read, 4000)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  if (!s) return null
  const ram = s.memoryUsedPercent
  const gpu = s.vramUsedPercent
  const title = [
    `Memory: ${ram}% in use`,
    gpu === null ? 'Graphics memory: not readable on this card' : `Graphics memory: ${gpu}% in use`,
    s.aiRunning ? 'AI models are running' : 'No AI models running',
    s.settings.enabled ? `The safety stop stops them at ${s.settings.memoryPercent}% memory${gpu === null ? '' : ` or ${s.settings.vramPercent}% graphics memory`}` : 'The safety stop is off',
  ].join('\n')
  const bar = (label: string, v: number, stopAt: number) => <span className={`meter meter--${level(v, stopAt)}`}>
    <small>{label}</small><i><b style={{ width: `${Math.min(100, v)}%` }} /></i><em>{v}%</em>
  </span>
  return <button className="system-meter" onClick={() => openSettings('activity')} title={title} aria-label={title}>
    {bar('RAM', ram, s.settings.memoryPercent)}
    {gpu !== null && bar('GPU', gpu, s.settings.vramPercent)}
    {s.aiRunning && <span className="system-meter__ai" title="AI models are running">AI</span>}
  </button>
}
