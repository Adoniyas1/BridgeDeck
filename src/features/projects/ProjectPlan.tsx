import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarRange, ExternalLink, FileSpreadsheet, Package, Plus, Trash2 } from 'lucide-react'
import { isTauri, openExternal, openPath, projectFileRead, projectFileWrite, type CalEvent, type Note } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { partsTotals, readParts, readSettings, timelineItems, timelineSpan, writeParts, type PartRow, type ProjectSettings } from './plan'

const DAY = 86_400_000
const DAY_W = 22

/** The project on a time line: board cards with due dates as bars (length from "[3d]" in the card),
 *  milestones as diamonds, and today. */
export function TimelineCard({ board, milestones }: { board: Note | undefined; milestones: CalEvent[] }) {
  const items = useMemo(() => timelineItems(board, milestones), [board, milestones])
  const [from, to] = useMemo(() => timelineSpan(items), [items])
  const scroller = useRef<HTMLDivElement>(null)
  const days = Math.round((to - from) / DAY)
  const x = (ms: number) => ((ms - from) / DAY) * DAY_W
  const today = new Date(); today.setHours(0, 0, 0, 0)
  useEffect(() => { if (scroller.current) scroller.current.scrollLeft = Math.max(0, x(today.getTime()) - 120) }, [from])
  const dates = Array.from({ length: days }, (_, i) => new Date(from + i * DAY + DAY / 2))
  return <Card><SectionTitle title="Timeline" subtitle="Cards with due dates and milestones. Add “[3d]” or “[2w]” to a card for how long it takes." action={<CalendarRange size={18} />} />
    {!items.length ? <p className="hint">Give board cards a due date (the calendar button on a card) or add a milestone, and they show here.</p> :
      <div className="ptl">
        <div className="ptl-labels">
          <div className="ptl-head" />
          {items.map(item => <div key={item.id} className={`ptl-label${item.done ? ' done' : ''}`} title={item.title}>{item.kind === 'milestone' ? '◆ ' : ''}{item.title}</div>)}
        </div>
        <div className="ptl-scroll" ref={scroller}>
          <div className="ptl-track" style={{ width: days * DAY_W }}>
            <div className="ptl-head">
              {dates.map((d, i) => <span key={i} className={`ptl-day${d.getDay() === 0 || d.getDay() === 6 ? ' weekend' : ''}`} style={{ left: i * DAY_W, width: DAY_W }}>
                {d.getDate() === 1 || i === 0 ? <b>{d.toLocaleDateString([], { month: 'short' })}</b> : null}{d.getDate()}
              </span>)}
            </div>
            {items.map(item => <div key={item.id} className="ptl-row">
              {item.kind === 'milestone'
                ? <span className={`ptl-milestone${item.done ? ' done' : ''}`} style={{ left: x(item.start) + DAY_W / 2 - 7 }} title={`${item.title} · ${new Date(item.start).toLocaleDateString()}`} />
                : <span className={`ptl-bar${item.done ? ' done' : ''}${!item.done && item.end < Date.now() ? ' late' : ''}`} style={{ left: x(item.start) + 1, width: Math.max(DAY_W, x(item.end) - x(item.start)) - 2 }}
                    title={`${item.title}\n${item.column} · due ${new Date(item.end - 1).toLocaleDateString()}`} />}
            </div>)}
            <span className="ptl-today" style={{ left: x(today.getTime()) + DAY_W / 2 }} />
          </div>
        </div>
      </div>}
  </Card>
}

const blankPart = (): PartRow => ({ item: '', qty: 1, price: 0, supplier: '', link: '', bought: false, notes: '' })

/** The parts to buy, what they cost and the budget: parts.csv in the project folder (opens in a
 *  spreadsheet too) and the budget in project.json. Saved as you type. */
export function PartsCard({ project, root }: { project: string; root: string }) {
  const [parts, setParts] = useState<PartRow[] | null>(null)
  const [settings, setSettings] = useState<ProjectSettings>({ budget: null, currency: '$' })
  const [error, setError] = useState('')
  const timer = useRef<number>()
  const loadedFor = useRef('')

  useEffect(() => {
    if (!isTauri()) { setParts([]); return }
    loadedFor.current = ''
    setParts(null)
    void Promise.all([projectFileRead(project, 'parts.csv'), projectFileRead(project, 'project.json')])
      .then(([csv, json]) => { setParts(readParts(csv)); setSettings(readSettings(json)); loadedFor.current = project })
      .catch(e => { setParts([]); setError(errorText(e, 'Couldn’t read the parts list')) })
  }, [project])

  function save(nextParts: PartRow[], nextSettings = settings) {
    window.clearTimeout(timer.current)
    if (loadedFor.current !== project) return
    timer.current = window.setTimeout(() => {
      void Promise.all([
        projectFileWrite(project, 'parts.csv', writeParts(nextParts.filter(p => p.item.trim()))),
        projectFileWrite(project, 'project.json', JSON.stringify(nextSettings, null, 2)),
      ]).then(() => setError('')).catch(e => setError(errorText(e, 'Couldn’t save the parts list')))
    }, 700)
  }
  const update = (i: number, patch: Partial<PartRow>) => setParts(list => { const next = (list ?? []).map((p, j) => (j === i ? { ...p, ...patch } : p)); save(next); return next })
  const remove = (i: number) => setParts(list => { const next = (list ?? []).filter((_, j) => j !== i); save(next); return next })
  const add = () => setParts(list => [...(list ?? []), blankPart()])
  const setBudget = (text: string) => { const budget = text.trim() === '' ? null : Number(text); if (budget !== null && !Number.isFinite(budget)) return; const next = { ...settings, budget }; setSettings(next); save(parts ?? [], next) }

  const totals = partsTotals(parts ?? [], settings.budget)
  const fmt = (n: number) => `${n < 0 ? '−' : ''}${settings.currency}${Math.abs(n).toFixed(2)}`
  return <Card><SectionTitle title="Parts and budget" subtitle={parts?.length ? `${parts.filter(p => p.item).length} parts · ${fmt(totals.total)}${settings.budget != null ? ` of ${fmt(settings.budget)}` : ''}` : 'What to buy and what it costs'}
    action={<div className="actions"><button className="secondary" title="Open parts.csv in your spreadsheet app" disabled={!isTauri()} onClick={() => void openPath(`${root}/${project}/parts.csv`).catch(() => setError('Add a part first, then it can open in a spreadsheet.'))}><FileSpreadsheet size={14} /></button><button className="secondary" onClick={add}><Plus size={14} />Part</button></div>} />
    {parts === null ? <p className="hint">Reading…</p> : <>
      {parts.length > 0 && <div className="parts-wrap"><table className="parts-table">
        <thead><tr><th>Bought</th><th>Part</th><th>Qty</th><th>Each</th><th>Total</th><th>Supplier</th><th>Link</th><th /></tr></thead>
        <tbody>{parts.map((p, i) => <tr key={i} className={p.bought ? 'bought' : ''}>
          <td><input type="checkbox" checked={p.bought} onChange={e => update(i, { bought: e.target.checked })} /></td>
          <td><input value={p.item} placeholder="74HC00, servo, 330 Ω…" autoFocus={!p.item && i === parts.length - 1} onChange={e => update(i, { item: e.target.value })} /></td>
          <td><input className="num" type="number" min={0} value={p.qty} onChange={e => update(i, { qty: Math.max(0, Number(e.target.value) || 0) })} /></td>
          <td><input className="num" type="number" min={0} step="0.01" value={p.price} onChange={e => update(i, { price: Math.max(0, Number(e.target.value) || 0) })} /></td>
          <td className="num">{fmt(p.qty * p.price)}</td>
          <td><input value={p.supplier} placeholder="DigiKey" onChange={e => update(i, { supplier: e.target.value })} /></td>
          <td className="link"><input value={p.link} placeholder="https://…" onChange={e => update(i, { link: e.target.value })} />{/^https?:\/\//.test(p.link) && <button className="notes-icon" title="Open the link" onClick={() => void openExternal(p.link)}><ExternalLink size={12} /></button>}</td>
          <td><button className="notes-icon" title="Remove" onClick={() => remove(i)}><Trash2 size={12} /></button></td>
        </tr>)}</tbody>
      </table></div>}
      {!parts.length && <div className="empty-state small"><Package size={22} /><p>List the parts to buy with their price; the total is checked against your budget.</p><button onClick={add}><Plus size={14} />Add a part</button></div>}
      <div className="parts-totals">
        <label>Budget <span>{settings.currency}</span><input className="num" type="number" min={0} step="1" placeholder="none" value={settings.budget ?? ''} onChange={e => setBudget(e.target.value)} /></label>
        <span>Total <strong>{fmt(totals.total)}</strong></span>
        <span>Bought <strong>{fmt(totals.spent)}</strong></span>
        <span>To buy <strong>{fmt(totals.toBuy)}</strong></span>
        {totals.left != null && <span className={totals.over ? 'over' : 'left'}>{totals.over ? 'Over by' : 'Left'} <strong>{fmt(Math.abs(totals.left))}</strong></span>}
      </div>
    </>}
    {error && <p className="error-text">{error}</p>}
  </Card>
}
