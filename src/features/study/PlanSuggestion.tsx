import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { CalendarPlus, Sparkles } from 'lucide-react'
import { isTauri, mimirPlanDone } from '../../lib/bridge'
import { activateTab } from '../../core/tabs'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { formatTime } from '../calendar/model'
import { useStudyPlan } from './studyPlan'

const DISMISSED_KEY = 'bridgedeck.study.planDismissed'
const HOUR = 3_600_000

/** "Now", moved on every hour, so a plan worked out in the background doesn't go stale. */
function useHourlyNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), HOUR); return () => window.clearInterval(t) }, [])
  return now
}

/** Mimir asked to plan the week ("plan my week"): the Study planner works it out and puts it in the
 *  calendar, and Mimir is told what was added (src-tauri bridgelink/mimir_api.rs /mimir/study/plan/make). */
export function PlanForMimir() {
  const now = useHourlyNow()
  const study = useStudyPlan(now)
  const latest = useRef(study)
  latest.current = study
  useEffect(() => {
    if (!isTauri()) return
    let off: (() => void) | undefined, closed = false
    void listen('mimir-plan-study', async () => {
      const { plan, chosen, warnings, applyPlan } = latest.current
      try {
        const { added, replaced } = await applyPlan()
        const short = Object.entries(plan.short).map(([id, hours]) => ({ task: chosen.find(t => t.id === id)?.title ?? id, hours }))
        await mimirPlanDone({ added, replaced, blocks: plan.blocks.slice(0, 30).map(b => ({ title: b.title, start: b.start, end: b.end })), short, warnings: warnings.map(w => w.text) })
      } catch (e) {
        await mimirPlanDone({ error: errorText(e, 'The plan couldn’t be added') })
      }
    }).then(fn => { if (closed) fn(); else off = fn })
    return () => { closed = true; off?.() }
  }, [])
  return null
}

/** On Home: deadlines with no study time planned yet, and the planner's blocks for them, to add in
 *  one click (nothing goes in the calendar without it). */
export function PlanSuggestion() {
  const now = useHourlyNow()
  const { unplanned, plan, old, applyPlan } = useStudyPlan(now)
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISSED_KEY) ?? '' } catch { return '' } })
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const key = unplanned.map(t => t.id).sort().join(',')
  if (!isTauri() || !unplanned.length || key === dismissed) return status ? <p className="hint">{status}</p> : null
  const hours = plan.blocks.reduce((n, b) => n + b.end - b.start, 0) / HOUR
  const first = plan.blocks[0]
  const dismiss = () => { setDismissed(key); try { localStorage.setItem(DISMISSED_KEY, key) } catch { /* this run only */ } }
  async function add() {
    setBusy(true)
    try {
      const { added, replaced } = await applyPlan()
      setStatus(`Added ${added} study block${added === 1 ? '' : 's'} to your calendar${replaced ? ` (your last plan's ${replaced} replaced)` : ''}.`)
    } catch (e) { setStatus(errorText(e, 'Couldn’t add them')) } finally { setBusy(false) }
  }
  return <Card className="incoming-card"><SectionTitle title="Plan study time?" subtitle={`${unplanned.length} deadline${unplanned.length === 1 ? '' : 's'} with no study time planned yet`} action={<Sparkles size={20} />} />
    <ul className="plan-suggest">{unplanned.slice(0, 5).map(t => <li key={t.id}><strong>{t.title}</strong>{t.course ? ` · ${t.course}` : ''} <small>due {new Date(t.due).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, about {t.hours} h</small></li>)}</ul>
    <p className="hint">The planner fits {hours.toFixed(1)} h of study into your free time{first ? `, starting ${new Date(first.start).toLocaleDateString([], { weekday: 'long' })} ${formatTime(first.start)}` : ''}{old.length ? `, and updates the ${old.length} block${old.length === 1 ? '' : 's'} already planned` : ''}. Or ask Mimir to “plan my week”.</p>
    <div className="actions">
      <button disabled={busy} onClick={() => void add()}><CalendarPlus size={15} />{busy ? 'Adding…' : 'Add to calendar'}</button>
      <button className="secondary" onClick={() => activateTab('study')}>Review in Study</button>
      <button className="secondary" onClick={dismiss}>Not now</button>
    </div>
    {status && <p className="hint">{status}</p>}
  </Card>
}
