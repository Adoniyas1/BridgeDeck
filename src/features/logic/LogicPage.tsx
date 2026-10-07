import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, CircuitBoard, FilePlus, FolderOpen, Grid2x2, History, NotebookPen, Pause, Play, Save, Table2, Trash2, Wand2 } from 'lucide-react'
import { circuitDelete, circuitLoad, circuitSave, circuitsList, circuitVersionLoad, circuitVersions, isTauri, notesCreateMarkdown, projectsList, type CircuitFile } from '../../lib/bridge'
import { useConfig } from '../../core/config'
import { errorText } from '../../core/util'
import { projectFolder } from '../projects/model'
import {
  buildCircuit, chipDef, chipPlan, CHIPS, emptyCircuit, expressions, GRID, groupsCovering, kmapGroups, kmapLayout, minimize, termOf, timing, newId, nextLabel, parseOutputs, pinPoint, pinRef, pinsOf, readCircuit,
  show, simulate, tableMarkdown, tableOf, truthTable, type Circuit, type FlopState, type GateType, type Level, type Part, type TruthTable,
} from './model'
import { levelColor, PartShape } from './Symbols'

const W = 2400, H = 1600
const snap = (v: number) => Math.round(v / GRID) * GRID
type Selection = { kind: 'part' | 'wire'; id: string } | null
type PaletteItem = { kind: Part['kind']; gate?: GateType; chip?: string; anode?: boolean; title: string }

const INPUTS: PaletteItem[] = [
  { kind: 'switch', title: 'Switch (input)' }, { kind: 'clock', title: 'Clock' }, { kind: 'led', title: 'LED (output)' },
  { kind: 'vcc', title: '+5V (VCC)' }, { kind: 'gnd', title: 'Ground' },
  { kind: 'seg7', title: '7-segment (lit on 1)' }, { kind: 'seg7', anode: true, title: '7-segment (lit on 0, for a 7447)' },
]
const GATE_ITEMS: PaletteItem[] = (['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR', 'XNOR', 'BUF'] as GateType[]).map(gate => ({ kind: 'gate', gate, title: gate }))

/** Logic gates and 74-series chips: design a circuit, watch it work, get its truth table and the chips to build it with. */
export default function LogicPage({ active }: { active: boolean }) {
  const config = useConfig()
  const [circuit, setCircuit] = useState<Circuit>(emptyCircuit)
  const [selection, setSelection] = useState<Selection>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [mouse, setMouse] = useState({ x: 0, y: 0 })
  const [inputs, setInputs] = useState(2)
  const [running, setRunning] = useState(false)
  const [clock, setClock] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [panel, setPanel] = useState<'table' | 'kmap' | 'timing' | 'design' | 'chips'>('table')
  const [file, setFile] = useState({ project: '', name: 'Untitled circuit' })
  const [files, setFiles] = useState<CircuitFile[]>([])
  const [projects, setProjects] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)
  const [versions, setVersions] = useState<number[]>([])
  const svg = useRef<SVGSVGElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null)
  const flops = useRef<FlopState>({})

  const change = (next: (c: Circuit) => Circuit) => { setCircuit(next); setDirty(true) }

  // The circuit's levels; flip-flops remember their state from step to step.
  const sim = useMemo(() => {
    const result = simulate(circuit, { clock, state: flops.current })
    flops.current = result.state
    return result
  }, [circuit, clock])
  const table = useMemo(() => truthTable(circuit), [circuit])
  const exprs = useMemo(() => (table.error || table.sequential ? {} : expressions(table)), [table])
  const plan = useMemo(() => (panel === 'chips' ? chipPlan(circuit) : null), [circuit, panel])

  useEffect(() => {
    if (!running || !active) return
    const timer = window.setInterval(() => setClock(c => !c), 500 / speed)
    return () => window.clearInterval(timer)
  }, [running, active, speed])

  const refreshFiles = () => { if (isTauri()) void circuitsList().then(setFiles).catch(() => undefined) }
  useEffect(() => {
    if (!active || !isTauri()) return
    refreshFiles()
    void projectsList(config.syncthing.sharedFolderPath).then(l => setProjects(l.projects.map(p => p.name))).catch(() => undefined)
  }, [active, config.syncthing.sharedFolderPath])

  // Keys: Delete removes what's selected, Escape cancels a wire.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      if (e.key === 'Escape') { setPending(null); setSelection(null) }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); remove(selection) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function remove(sel: NonNullable<Selection>) {
    change(c => sel.kind === 'wire'
      ? { ...c, wires: c.wires.filter(w => w.id !== sel.id) }
      : { ...c, parts: c.parts.filter(p => p.id !== sel.id), wires: c.wires.filter(w => !w.a.startsWith(`${sel.id}:`) && !w.b.startsWith(`${sel.id}:`)) })
    setSelection(null)
  }

  /** A new part, near the middle of what's on screen (or where it was dropped). */
  function add(item: PaletteItem, at?: { x: number; y: number }) {
    const box = scroller.current
    // On screen, in a grid of free spots (parts added one after another don't land on each other).
    const n = circuit.parts.length
    const place = at ?? { x: (box?.scrollLeft ?? 0) + 60 + (n % 5) * 170, y: (box?.scrollTop ?? 0) + 60 + (Math.floor(n / 5) % 6) * 120 }
    change(c => {
      const part: Part = { id: newId(item.kind[0]), kind: item.kind, x: snap(place.x), y: snap(place.y) }
      if (item.kind === 'gate') { part.gate = item.gate; part.inputs = item.gate === 'NOT' || item.gate === 'BUF' ? 1 : inputs }
      if (item.kind === 'chip') part.chip = item.chip
      if (item.kind === 'switch' || item.kind === 'clock' || item.kind === 'led') part.label = nextLabel(c, item.kind)
      if (item.kind === 'switch') part.on = false
      if (item.kind === 'seg7') part.on = !!item.anode
      return { ...c, parts: [...c.parts, part] }
    })
  }

  const point = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function pinDown(e: React.PointerEvent, ref: string) {
    e.stopPropagation()
    if (!pending) { setPending(ref); setMouse(point(e)); return }
    if (pending !== ref) {
      change(c => c.wires.some(w => (w.a === pending && w.b === ref) || (w.a === ref && w.b === pending)) ? c : { ...c, wires: [...c.wires, { id: newId('w'), a: pending, b: ref }] })
    }
    setPending(null)
  }

  function partDown(e: React.PointerEvent, part: Part) {
    e.stopPropagation()
    const p = point(e)
    drag.current = { id: part.id, dx: p.x - part.x, dy: p.y - part.y, moved: false }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  function move(e: React.PointerEvent) {
    const p = point(e)
    if (pending) setMouse(p)
    const d = drag.current
    if (!d) return
    const x = snap(Math.max(0, p.x - d.dx)), y = snap(Math.max(20, p.y - d.dy))
    const part = circuit.parts.find(q => q.id === d.id)
    if (part && (part.x !== x || part.y !== y)) {
      d.moved = true
      setCircuit(c => ({ ...c, parts: c.parts.map(q => (q.id === d.id ? { ...q, x, y } : q)) }))
      setDirty(true)
    }
  }

  function up() {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const part = circuit.parts.find(p => p.id === d.id)
    // A click: a switch flips; anything else is selected.
    if (part?.kind === 'switch') change(c => ({ ...c, parts: c.parts.map(p => (p.id === part.id ? { ...p, on: !p.on } : p)) }))
    setSelection({ kind: 'part', id: d.id })
  }

  async function run(action: () => Promise<void>) {
    setMessage('')
    try { await action() } catch (e) { setMessage(errorText(e, 'That didn’t work')) }
  }

  const save = () => run(async () => {
    await circuitSave(file.project, file.name.trim(), JSON.stringify(circuit))
    setDirty(false)
    setMessage(`Saved${file.project ? ` in ${file.project}` : ''}.`)
    refreshFiles()
  })

  const open = (f: CircuitFile) => run(async () => {
    if (dirty && !window.confirm('Open another circuit? Changes to this one aren’t saved.')) return
    setCircuit(readCircuit(await circuitLoad(f.project, f.name)))
    setFile({ project: f.project, name: f.name })
    setDirty(false)
    flops.current = {}
  })

  const fresh = () => {
    if (dirty && !window.confirm('Start a new circuit? Changes to this one aren’t saved.')) return
    setCircuit(emptyCircuit())
    setFile(f => ({ project: f.project, name: 'Untitled circuit' }))
    setDirty(false)
    flops.current = {}
  }

  const toNote = (title: string, markdown: string) => run(async () => {
    await notesCreateMarkdown(title, file.project ? projectFolder(file.project) : 'Logic', 'note', markdown)
    setMessage(`Saved as a note in ${file.project ? projectFolder(file.project) : 'Logic'}.`)
  })

  const level = (part: Part) => (pin: string): Level | undefined => sim.pins[pinRef(part, pin)]
  const current = table.rows.findIndex(r => r.in.every((bit, i) => circuit.parts.find(p => p.kind === 'switch' && p.label === table.inputs[i])?.on === (bit === 1)))

  return <div className="logic">
    <div className="logic-bar">
      <CircuitBoard size={16} />
      <input className="logic-name" value={file.name} onChange={e => setFile(f => ({ ...f, name: e.target.value }))} aria-label="Circuit name" />
      <select value={file.project} onChange={e => setFile(f => ({ ...f, project: e.target.value }))} title="Which project it's saved in">
        <option value="">No project</option>
        {projects.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
      <button className="ghost" onClick={() => void save()} disabled={!isTauri()}><Save size={14} /> Save{dirty ? ' •' : ''}</button>
      <details className="logic-open">
        <summary className="ghost"><FolderOpen size={14} /> Open</summary>
        <div className="logic-files">
          {files.length ? files.map(f => <div key={`${f.project}/${f.name}`} className="logic-file">
            <button onClick={() => void open(f)}><span>{f.name}</span><small>{f.project || 'No project'}</small></button>
            <button className="ghost" title="Delete" onClick={() => { if (window.confirm(`Delete ${f.name}?`)) void run(async () => { await circuitDelete(f.project, f.name); refreshFiles() }) }}><Trash2 size={12} /></button>
          </div>) : <p className="hint">No saved circuits yet.</p>}
        </div>
      </details>
      <details className="logic-open" onToggle={e => { if ((e.target as HTMLDetailsElement).open && isTauri()) void circuitVersions(file.project, file.name.trim()).then(setVersions).catch(() => setVersions([])) }}>
        <summary className="ghost" title="Earlier saved versions of this circuit"><History size={14} /> Versions</summary>
        <div className="logic-files">
          {versions.length ? versions.map(at => <div key={at} className="logic-file">
            <button onClick={() => void run(async () => {
              if (dirty && !window.confirm('Open an earlier version? Changes to the circuit on screen aren’t saved.')) return
              setCircuit(readCircuit(await circuitVersionLoad(file.project, file.name.trim(), at)))
              setDirty(true)
              flops.current = {}
              setMessage(`Opened the version saved before ${new Date(at).toLocaleString()}. Save to keep it (the current one stays in Versions).`)
            })}><span>{new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span><small>replaced then</small></button>
          </div>) : <p className="hint">No earlier versions. Each save keeps the one it replaces.</p>}
        </div>
      </details>
      <button className="ghost" onClick={fresh}><FilePlus size={14} /> New</button>
      <span className="grow" />
      <button className={`ghost${running ? ' active' : ''}`} onClick={() => setRunning(r => !r)} title="Run the clock parts">{running ? <Pause size={14} /> : <Play size={14} />} Clock</button>
      <select value={speed} onChange={e => setSpeed(Number(e.target.value))} title="Clock speed">
        <option value={0.5}>0.5 Hz</option><option value={1}>1 Hz</option><option value={2}>2 Hz</option><option value={5}>5 Hz</option>
      </select>
      <button className="ghost" disabled={!running} onClick={() => setClock(c => !c)} title="One clock edge">Step</button>
    </div>
    {message && <p className="hint logic-message">{message}</p>}
    <div className="logic-main">
      <aside className="logic-palette">
        <h4>Inputs and outputs</h4>
        {INPUTS.map(item => <PaletteButton key={item.title} item={item} onAdd={add} />)}
        <h4>Gates <select value={inputs} onChange={e => setInputs(Number(e.target.value))} title="Inputs for new gates"><option value={2}>2 in</option><option value={3}>3 in</option><option value={4}>4 in</option></select></h4>
        {GATE_ITEMS.map(item => <PaletteButton key={item.title} item={item} onAdd={add} />)}
        <h4>74-series chips</h4>
        {CHIPS.map(c => <PaletteButton key={c.part} item={{ kind: 'chip', chip: c.part, title: `${c.part} · ${c.name}` }} onAdd={add} />)}
        <p className="hint">Click a pin, then another, to wire them. Drag parts to move them; click a switch to flip it; Delete removes what’s selected. 14-pin chips need pin 14 to +5V and pin 7 to ground; 16-pin chips pin 16 and pin 8. Unconnected chip control inputs count as high, as on real TTL chips.</p>
      </aside>
      <div ref={scroller} className="logic-canvas" onDragOver={e => e.preventDefault()} onDrop={e => {
        e.preventDefault()
        try { const item = JSON.parse(e.dataTransfer.getData('application/x-logic')) as PaletteItem; add(item, point(e)) } catch { /* not a part */ }
      }}>
        <svg ref={svg} width={W} height={H} onPointerMove={move} onPointerUp={up} onPointerDown={() => { setPending(null); setSelection(null) }}>
          <defs><pattern id="logic-grid" width={20} height={20} patternUnits="userSpaceOnUse"><circle cx={1} cy={1} r={1} className="logic-dot" /></pattern></defs>
          <rect width={W} height={H} fill="url(#logic-grid)" />
          {circuit.wires.map(w => {
            const pa = circuit.parts.find(p => w.a.startsWith(`${p.id}:`)), pb = circuit.parts.find(p => w.b.startsWith(`${p.id}:`))
            const a = pa && pinPoint(pa, w.a.slice(pa.id.length + 1)), b = pb && pinPoint(pb, w.b.slice(pb.id.length + 1))
            if (!a || !b) return null
            // Each source gets its own lane for the vertical run, so different signals don't overlap.
            const [from, to, src] = (pinsOf(pa!).find(p => p.name === w.a.slice(pa!.id.length + 1))?.dir === 'out') ? [a, b, pa!] : [b, a, pb!]
            const lane = circuit.parts.indexOf(src) % 6
            const room = to.x - from.x
            const mid = room >= 30 ? Math.min(to.x - 10, from.x + 10 + lane * (room > 70 ? 8 : 4)) : Math.round((from.x + to.x) / 2 / GRID) * GRID
            const d = `M${from.x},${from.y} H${mid} V${to.y} H${to.x}`
            const short = sim.shorts.includes(w.id)
            const sel = selection?.kind === 'wire' && selection.id === w.id
            return <g key={w.id} onPointerDown={e => { e.stopPropagation(); setSelection({ kind: 'wire', id: w.id }) }}>
              <path d={d} className="logic-wire-hit" />
              <path d={d} className={`logic-wire${sel ? ' selected' : ''}`} style={{ stroke: short ? 'var(--logic-short)' : levelColor(sim.pins[w.a]) }} />
            </g>
          })}
          {circuit.parts.map(part => <g key={part.id} onPointerDown={e => partDown(e, part)}>
            <PartShape part={part} level={level(part)} selected={selection?.kind === 'part' && selection.id === part.id} />
            {pinsOf(part).filter(p => p.dir !== 'nc').map(pin => {
              const ref = pinRef(part, pin.name)
              return <circle key={pin.name} cx={part.x + pin.x} cy={part.y + pin.y} r={5} className={`logic-pin${pending === ref ? ' pending' : ''}`} style={{ fill: levelColor(sim.pins[ref]) }}
                onPointerDown={e => pinDown(e, ref)}><title>{pin.label ? `Pin ${pin.name} (${pin.label})` : pin.name}</title></circle>
            })}
          </g>)}
          {pending && (() => {
            const part = circuit.parts.find(p => pending.startsWith(`${p.id}:`))
            const from = part && pinPoint(part, pending.slice(part.id.length + 1))
            return from ? <path d={`M${from.x},${from.y} L${mouse.x},${mouse.y}`} className="logic-wire pending" /> : null
          })()}
        </svg>
        {!circuit.parts.length && <div className="logic-empty"><CircuitBoard size={28} /><p>Add switches, gates or chips from the left, then wire their pins. Or build one from an expression or a truth table on the right.</p></div>}
      </div>
      <aside className="logic-side">
        <div className="logic-tabs">
          <button className={panel === 'table' ? 'on' : ''} onClick={() => setPanel('table')}><Table2 size={13} /> Table</button>
          <button className={panel === 'kmap' ? 'on' : ''} onClick={() => setPanel('kmap')}><Grid2x2 size={13} /> K-map</button>
          <button className={panel === 'timing' ? 'on' : ''} onClick={() => setPanel('timing')}><Activity size={13} /> Timing</button>
          <button className={panel === 'design' ? 'on' : ''} onClick={() => setPanel('design')}><Wand2 size={13} /> Design</button>
          <button className={panel === 'chips' ? 'on' : ''} onClick={() => setPanel('chips')}><CircuitBoard size={13} /> Chips</button>
        </div>
        {sim.warnings.length > 0 && <ul className="logic-warnings">{sim.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
        {panel === 'table' && <>
          {table.error ? <p className="hint">{table.error}</p> : !table.inputs.length || !table.outputs.length ? <p className="hint">Add at least one switch and one LED: the table fills itself in from the circuit.</p> : <>
            <TableView table={table} highlight={current} />
            {table.sequential ? <p className="hint">This circuit has a clock or flip-flops: its outputs depend on what happened before, so the table shows only the state right after power-up.</p>
              : <div className="logic-exprs">{Object.entries(exprs).map(([k, v]) => <div key={k}><strong>{k}</strong> = {v}</div>)}</div>}
            <button className="ghost" onClick={() => void toNote(`${file.name} – truth table`, tableMarkdown(table, exprs))}><NotebookPen size={13} /> Save as a note</button>
          </>}
        </>}
        {panel === 'kmap' && (table.error ? <p className="hint">{table.error}</p> : table.sequential ? <p className="hint">Karnaugh maps are for circuits without a clock or flip-flops.</p>
          : !table.outputs.length || !kmapLayout(table.inputs) ? <p className="hint">A Karnaugh map needs 2 to 4 switches and at least one LED.</p> : <KMapView table={table} />)}
        {panel === 'timing' && <TimingView circuit={circuit} />}
        {panel === 'design' && <Designer onBuild={c => { if (!dirty || window.confirm('Replace the circuit on the canvas?')) { setCircuit(c); setDirty(true); flops.current = {}; setPanel('table') } }} onNote={toNote} />}
        {panel === 'chips' && plan && <>
          {!plan.chips.length ? <p className="hint">Gates you place are matched to real chips here (chips already on the canvas are wired as drawn).</p> : <>
            <h4>Chips needed</h4>
            {plan.chips.map(ch => <div key={ch.ref} className="logic-chip-row"><strong>{ch.ref}</strong> {ch.part} <small>{ch.name}</small><div className="hint">{ch.slots.map((s, i) => s ? `gate ${i + 1}: ${s.gate}` : `gate ${i + 1}: spare`).join(' · ')}</div></div>)}
            <h4>Wiring</h4>
            <ul className="logic-wiring">{plan.connections.map(c => <li key={c.net}><strong>{c.net}</strong>: {c.pins.join(', ')}</li>)}</ul>
            {plan.notes.map(n => <p key={n} className="hint">{n}</p>)}
            <button className="ghost" onClick={() => void toNote(`${file.name} – chips and wiring`, [`## Chips`, ...plan.chips.map(ch => `- ${ch.ref}: ${ch.part} (${ch.name})`), '', '## Wiring', ...plan.connections.map(c => `- **${c.net}**: ${c.pins.join(', ')}`)].join('\n'))}><NotebookPen size={13} /> Save as a note</button>
          </>}
        </>}
      </aside>
    </div>
  </div>
}

function PaletteButton({ item, onAdd }: { item: PaletteItem; onAdd: (item: PaletteItem) => void }) {
  return <button className="logic-palette-item" draggable onDragStart={e => e.dataTransfer.setData('application/x-logic', JSON.stringify(item))} onClick={() => onAdd(item)} title={item.kind === 'chip' ? chipDef(item.chip)?.name : undefined}>{item.title}</button>
}

function TableView({ table, highlight, onCell }: { table: TruthTable; highlight?: number; onCell?: (row: number, out: number) => void }) {
  return <div className="logic-table-wrap"><table className="logic-table">
    <thead><tr>{table.inputs.map(n => <th key={`i${n}`}>{n}</th>)}{table.outputs.map(n => <th key={`o${n}`} className="out">{n}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, r) => <tr key={r} className={r === highlight ? 'now' : ''}>
      {row.in.map((v, i) => <td key={i}>{v}</td>)}
      {row.out.map((v, o) => <td key={`o${o}`} className={`out${onCell ? ' edit' : ''}`} onClick={onCell ? () => onCell(r, o) : undefined}>{v === null ? (onCell ? 'X' : '?') : v}</td>)}
    </tr>)}</tbody>
  </table></div>
}

/** How many variable letters an expression writes (to tell whether a simplification is shorter). */
const literals = (text: string) => (text.match(/[A-Z]/g) ?? []).length

/** Design from an expression, or by filling in a truth table's outputs. */
function Designer({ onBuild, onNote }: { onBuild: (c: Circuit) => void; onNote: (title: string, markdown: string) => void }) {
  const [mode, setMode] = useState<'expr' | 'table'>('expr')
  const [text, setText] = useState("Y = A·B + C'")
  const [count, setCount] = useState(3)
  const [cells, setCells] = useState<Level[]>(() => Array(8).fill(0))
  const parsed = useMemo(() => { try { return { outputs: parseOutputs(text), error: '' } } catch (e) { return { outputs: [], error: errorText(e, 'Can’t read that') } } }, [text])
  const exprTable = useMemo(() => (parsed.outputs.length ? tableOf(parsed.outputs) : null), [parsed])
  const vars = 'ABCDEF'.slice(0, count).split('')
  const filled: TruthTable = { inputs: vars, outputs: ['Y'], sequential: false, rows: cells.slice(0, 2 ** count).map((v, i) => ({ in: vars.map((_, b) => ((i >> (count - 1 - b)) & 1) as 0 | 1), out: [v] })) }
  const fromTable = minimize(vars, filled.rows.flatMap((r, i) => (r.out[0] === 1 ? [i] : [])), filled.rows.flatMap((r, i) => (r.out[0] === null ? [i] : [])))
  return <div className="logic-designer">
    <div className="logic-tabs small">
      <button className={mode === 'expr' ? 'on' : ''} onClick={() => setMode('expr')}>From an expression</button>
      <button className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>Fill in a table</button>
    </div>
    {mode === 'expr' ? <>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={3} spellCheck={false} />
      <p className="hint">One output per line, like <code>S = A ^ B</code>. And: <code>AB</code> <code>A·B</code> <code>A*B</code> <code>A AND B</code>; or: <code>+</code> <code>OR</code>; xor: <code>^</code> <code>⊕</code>; not: <code>A'</code> <code>!A</code> <code>~A</code> <code>NOT A</code>.</p>
      {parsed.error ? <p className="error-text">{parsed.error}</p> : exprTable && <>
        <div className="logic-exprs">{parsed.outputs.map(o => <div key={o.name}><strong>{o.name}</strong> = {show(o.expr)}{(() => { const s = expressions(exprTable)[o.name]; return s && literals(s) < literals(show(o.expr)) ? <span className="hint"> · simpler: {s}</span> : null })()}</div>)}</div>
        <TableView table={exprTable} />
        <div className="actions">
          <button onClick={() => onBuild(buildCircuit(parsed.outputs))}><Wand2 size={13} /> Build the circuit</button>
          <button className="ghost" onClick={() => onNote('Truth table', tableMarkdown(exprTable, Object.fromEntries(parsed.outputs.map(o => [o.name, show(o.expr)]))))}><NotebookPen size={13} /> Save as a note</button>
        </div>
      </>}
    </> : <>
      <label className="logic-count">Inputs <select value={count} onChange={e => { const n = Number(e.target.value); setCount(n); setCells(c => Array.from({ length: 2 ** n }, (_, i) => c[i] ?? 0)) }}>{[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <p className="hint">Click an output to change it: 0, 1, or X (doesn’t matter).</p>
      <TableView table={filled} onCell={r => setCells(c => c.map((v, i) => (i === r ? (v === 0 ? 1 : v === 1 ? null : 0) : v)))} />
      <div className="logic-exprs"><strong>Y</strong> = {fromTable}</div>
      {kmapLayout(vars) && <KMapView table={filled} />}
      <div className="actions">
        <button onClick={() => onBuild(buildCircuit(parseOutputs(`Y = ${fromTable}`)))}><Wand2 size={13} /> Build the circuit</button>
        <button className="ghost" onClick={() => onNote('Truth table', tableMarkdown(filled, { Y: fromTable }))}><NotebookPen size={13} /> Save as a note</button>
      </div>
    </>}
  </div>
}

const GROUP_COLORS = ['#f87171', '#60a5fa', '#4ade80', '#facc15', '#c084fc', '#2dd4bf', '#fb923c', '#f472b6']

/** An output's Karnaugh map: 1s, don't-cares (X), and the groups of the simplest sum of products. */
function KMapView({ table }: { table: TruthTable }) {
  const [out, setOut] = useState(0)
  const o = Math.min(out, table.outputs.length - 1)
  const map = kmapLayout(table.inputs)!
  const { groups } = kmapGroups(table, o)
  const bitsOf = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v >> (n - 1 - i)) & 1).join('')
  return <div className="logic-kmap">
    {table.outputs.length > 1 && <select value={o} onChange={e => setOut(Number(e.target.value))}>{table.outputs.map((name, i) => <option key={name} value={i}>{name}</option>)}</select>}
    <table>
      <thead><tr><th className="corner">{map.rowVars.join('')}\{map.colVars.join('')}</th>{map.cols.map(c => <th key={c}>{bitsOf(c, map.colVars.length)}</th>)}</tr></thead>
      <tbody>{map.rows.map(r => <tr key={r}><th>{bitsOf(r, map.rowVars.length)}</th>{map.cols.map(c => {
        const m = map.cell(r, c)
        const v = table.rows[m]?.out[o]
        const by = groupsCovering(groups, m)
        return <td key={c} className={v === 1 ? 'one' : v === null ? 'either' : ''} title={`Row ${m}`}>
          <span>{v === null ? 'X' : v}</span>
          <i>{by.map(g => <b key={g} style={{ background: GROUP_COLORS[g % GROUP_COLORS.length] }} />)}</i>
        </td>
      })}</tr>)}</tbody>
    </table>
    <div className="logic-kmap-terms"><strong>{table.outputs[o]}</strong> = {groups.length ? groups.map((g, i) => <span key={i}>{i > 0 && ' + '}<span className="term" style={{ borderColor: GROUP_COLORS[i % GROUP_COLORS.length] }}>{termOf(table.inputs, g)}</span></span>) : '0'}</div>
    <p className="hint">Each colour is one group of 1s (it can wrap around the edges); together they give the simplest sum of products. X cells can go either way.</p>
  </div>
}

/** Every clock, switch and LED over a number of clock cycles from power-up. */
function TimingView({ circuit }: { circuit: Circuit }) {
  const [cycles, setCycles] = useState(8)
  const t = useMemo(() => timing(circuit, cycles), [circuit, cycles])
  if (!t.signals.length) return <p className="hint">Add a clock, switches and LEDs: their levels over time show here, step by step.</p>
  const STEP = 18, ROW = 30, LEFT = 44, HIGH = 6, LOW = 22
  const width = LEFT + t.steps * STEP + 4
  const wave = (values: Array<0 | 1 | null>) => {
    let d = ''
    values.forEach((v, i) => {
      const x = LEFT + i * STEP, y = v === 1 ? HIGH : v === 0 ? LOW : (HIGH + LOW) / 2
      d += i === 0 ? `M${x},${y}` : ` V${y}`
      d += ` H${x + STEP}`
    })
    return d
  }
  return <div className="logic-timing">
    <label className="logic-count">Cycles <select value={cycles} onChange={e => setCycles(Number(e.target.value))}>{[4, 8, 16, 32].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    <div className="logic-timing-scroll"><svg width={width} height={t.signals.length * ROW + 16}>
      {Array.from({ length: t.steps / 2 }, (_, i) => <line key={i} x1={LEFT + (2 * i + 1) * STEP} y1={0} x2={LEFT + (2 * i + 1) * STEP} y2={t.signals.length * ROW} className="logic-timing-edge" />)}
      {t.signals.map((s, r) => <g key={s.name + r} transform={`translate(0,${r * ROW})`}>
        <text x={0} y={18} className={`logic-timing-name ${s.kind}`}>{s.name}</text>
        <path d={wave(s.values)} className={`logic-timing-wave ${s.kind}`} fill="none" />
      </g>)}
      {Array.from({ length: t.steps / 2 }, (_, i) => <text key={i} x={LEFT + (2 * i + 1) * STEP} y={t.signals.length * ROW + 12} className="logic-timing-tick" textAnchor="middle">{i + 1}</text>)}
    </svg></div>
    <p className="hint">From power-up: each cycle is the clock low, then high; dotted lines are rising edges, where flip-flops and counters change. Switches stay as they are on the canvas.</p>
  </div>
}
