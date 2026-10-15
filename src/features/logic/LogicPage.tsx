import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, CircuitBoard, FilePlus, FileText, Maximize, ZoomIn, ZoomOut, RotateCw, Spline, Minus, CornerDownRight, Eraser, FolderOpen, Grid2x2, History, NotebookPen, Pause, Play, Save, Table2, Trash2, Wand2 } from 'lucide-react'
import { reportSave, openPath, circuitDelete, circuitLoad, circuitSave, circuitsList, circuitVersionLoad, circuitVersions, isTauri, notesCreateMarkdown, projectsList, type CircuitFile } from '../../lib/bridge'
import { useConfig } from '../../core/config'
import { errorText } from '../../core/util'
import { projectFolder } from '../projects/model'
import {
  asChips, buildCircuit, buildWithRules, chipDef, designSummary, posExpressions, type DesignRules, chipPlan, CHIPS, emptyCircuit, expressions, GRID, groupsCovering, kmapGroups, kmapLayout, minimize, termOf, timing, newId, nextLabel, parseOutputs, pinPoint, pinRef, pinsOf, readCircuit, removePart, splitWire, placedPins, pinFacing, wirePath, bendIndex, rotateBy90, sizeOf, type Wire, type WireShape,
  show, simulate, tableMarkdown, tableOf, truthTable, type Circuit, type FlopState, type GateType, type Level, type Part, type TruthTable,
} from './model'
import { levelColor, PartShape } from './Symbols'
import Breadboard from './Breadboard'
import { CircuitMenu } from './Preview'
import FsmEditor from './FsmEditor'
import { buildFsmCircuit, loadCircuit } from './fsm'
import { reportHtml, reportMarkdown } from './report'
import { delayRun, levelAt } from './delays'

const W = 4000, H = 3000
const snap = (v: number) => Math.round(v / GRID) * GRID
type Selection = { kind: 'part' | 'wire'; id: string } | null
type PaletteItem = { kind: Part['kind']; gate?: GateType; chip?: string; anode?: boolean; title: string }

const INPUTS: PaletteItem[] = [
  { kind: 'switch', title: 'Switch (input)' }, { kind: 'clock', title: 'Clock' }, { kind: 'led', title: 'LED (output)' },
  { kind: 'vcc', title: '+5V (VCC)' }, { kind: 'gnd', title: 'Ground' },
  { kind: 'seg7', title: '7-segment (lit on 1)' }, { kind: 'seg7', anode: true, title: '7-segment (lit on 0, for a 7447)' },
  { kind: 'joint', title: 'Joint (wires branch here)' },
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
  /** The canvas shows the schematic or the same circuit on a breadboard. */
  const [view, setView] = useState<'schematic' | 'breadboard' | 'fsm'>('schematic')
  const [speed, setSpeed] = useState(1)
  const [panel, setPanel] = useState<'table' | 'kmap' | 'timing' | 'design' | 'chips'>('table')
  const [file, setFile] = useState({ project: '', name: 'Untitled circuit' })
  const [files, setFiles] = useState<CircuitFile[]>([])
  const [projects, setProjects] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)
  const [versions, setVersions] = useState<number[]>([])
  /** Open or Versions, whichever is showing (one at a time). */
  const [menu, setMenu] = useState<'open' | 'versions' | null>(null)
  /** The canvas: how far it's zoomed, and a drag on empty space moving the view. */
  const [zoom, setZoom] = useState(1)
  const pan = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null)
  /** A wire's bend point being dragged. */
  const bend = useRef<{ wire: string; index: number } | null>(null)
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
      if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && selection?.kind === 'part') { e.preventDefault(); rotate(selection.id) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** Turns a part a quarter turn clockwise; its wires follow its pins. */
  function rotate(id: string) {
    change(c => ({ ...c, parts: c.parts.map(p => (p.id === id ? { ...p, rot: rotateBy90(p.rot) } : p)) }))
  }

  function setWire(id: string, patch: (w: Wire) => Wire) {
    change(c => ({ ...c, wires: c.wires.map(w => (w.id === id ? patch(w) : w)) }))
  }

  /** The way a wire leaves a joint: towards its other end, or (when a wire made earlier already
   *  leaves that way) at a right angle, so a branch doesn't run along the wire it came off. */
  function jointFacing(w: Wire, ref: string, at: { x: number; y: number }, next: { x: number; y: number }) {
    const toward = (q: { x: number; y: number }) => Math.abs(q.x - at.x) >= Math.abs(q.y - at.y) ? { x: Math.sign(q.x - at.x) || 1, y: 0 } : { x: 0, y: Math.sign(q.y - at.y) || 1 }
    const mine = toward(next)
    const before = circuit.wires.slice(0, circuit.wires.indexOf(w)).filter(x => x.a === ref || x.b === ref)
    const taken = before.some(x => {
      const other = x.a === ref ? x.b : x.a
      const part = circuit.parts.find(p => other.startsWith(`${p.id}:`))
      const q = (x.a === ref ? x.via?.[0] : x.via?.[x.via.length - 1]) ?? (part && pinPoint(part, other.slice(part.id.length + 1)))
      if (!q) return false
      const t = toward(q)
      return t.x === mine.x && t.y === mine.y
    })
    if (!taken) return mine
    return mine.x !== 0 ? { x: 0, y: Math.sign(next.y - at.y) || 1 } : { x: Math.sign(next.x - at.x) || 1, y: 0 }
  }

  /** Where a wire's ends are, with the way each pin points. */
  function ends(w: Wire) {
    const pa = circuit.parts.find(p => w.a.startsWith(`${p.id}:`)), pb = circuit.parts.find(p => w.b.startsWith(`${p.id}:`))
    if (!pa || !pb) return null
    const na = w.a.slice(pa.id.length + 1), nb = w.b.slice(pb.id.length + 1)
    const a = pinPoint(pa, na), b = pinPoint(pb, nb)
    if (!a || !b) return null
    const fa = pa.kind === 'joint' ? jointFacing(w, w.a, a, w.via?.[0] ?? b) : pinFacing(pa, na)
    const fb = pb.kind === 'joint' ? jointFacing(w, w.b, b, w.via?.[w.via.length - 1] ?? a) : pinFacing(pb, nb)
    const aOut = pinsOf(pa).find(p => p.name === na)?.dir === 'out'
    const A = { ...a, fx: fa.x, fy: fa.y }, B = { ...b, fx: fb.x, fy: fb.y }
    // Bend points run from end a to end b. Without any, the wire is drawn from its output pin, so the
    // automatic route leaves the output and enters the input.
    const fromOut = !w.via?.length && !aOut
    return { A, B, from: fromOut ? B : A, to: fromOut ? A : B, src: aOut ? pa : pb }
  }

  function remove(sel: NonNullable<Selection>) {
    change(c => sel.kind === 'wire' ? { ...c, wires: c.wires.filter(w => w.id !== sel.id) } : removePart(c, sel.id))
    setSelection(null)
    setPending(null)
  }

  /** Joins two pins with a wire (unless they already are). */
  const connect = (c: Circuit, a: string, b: string): Circuit =>
    a === b || c.wires.some(w => (w.a === a && w.b === b) || (w.a === b && w.b === a)) ? c : { ...c, wires: [...c.wires, { id: newId('w'), a, b }] }

  /** A joint on a wire where it was clicked: the wire being drawn ends there, or (with nothing being
   *  drawn) a new wire starts from it, branching the signal. */
  function jointOn(w: Wire, at: { x: number; y: number }) {
    const e = ends(w)
    if (!e) return
    const { circuit: next, joint } = splitWire(circuit, w.id, e.A, e.B, { x: snap(at.x), y: snap(at.y) })
    if (!joint) return
    const ref = pinRef(joint, 'p')
    change(() => (pending ? connect(next, pending, ref) : next))
    setPending(pending ? null : ref)
    setMouse(at)
    setSelection({ kind: 'part', id: joint.id })
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
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }
  }

  /** Zooms keeping the point under `at` (window coordinates; the view's middle by default) still. */
  function zoomTo(next: number, at?: { clientX: number; clientY: number }) {
    const box = scroller.current
    const z = Math.min(2.5, Math.max(0.3, Math.round(next * 100) / 100))
    if (!box || z === zoom) return
    const r = box.getBoundingClientRect()
    const cx = at ? at.clientX - r.left : r.width / 2, cy = at ? at.clientY - r.top : r.height / 2
    const wx = (box.scrollLeft + cx) / zoom, wy = (box.scrollTop + cy) / zoom
    setZoom(z)
    requestAnimationFrame(() => { box.scrollLeft = wx * z - cx; box.scrollTop = wy * z - cy })
  }

  /** Zooms and scrolls so the whole circuit is in view. */
  function fit() {
    const box = scroller.current
    if (!box || !circuit.parts.length) return
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of circuit.parts) { const { w, h } = sizeOf(p); x0 = Math.min(x0, p.x - 30); y0 = Math.min(y0, p.y - 40); x1 = Math.max(x1, p.x + w + 40); y1 = Math.max(y1, p.y + h + 40) }
    const z = Math.min(2, Math.max(0.3, Math.min(box.clientWidth / (x1 - x0), box.clientHeight / (y1 - y0))))
    setZoom(z)
    requestAnimationFrame(() => { box.scrollLeft = x0 * z - (box.clientWidth - (x1 - x0) * z) / 2; box.scrollTop = y0 * z - (box.clientHeight - (y1 - y0) * z) / 2 })
  }

  // Pinch (or ⌘/Ctrl + scroll) zooms the canvas; plain scrolling moves it. (A native listener, so
  // the page itself doesn't zoom.)
  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomTo(zoom * Math.exp(-e.deltaY / 300), e)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  })

  function pinDown(e: React.PointerEvent, ref: string) {
    e.stopPropagation()
    if (!pending) { setPending(ref); setMouse(point(e)); return }
    change(c => connect(c, pending, ref))
    setPending(null)
  }

  function partDown(e: React.PointerEvent, part: Part) {
    e.stopPropagation()
    const p = point(e)
    drag.current = { id: part.id, dx: p.x - part.x, dy: p.y - part.y, moved: false }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  function move(e: React.PointerEvent) {
    const pn = pan.current, box = scroller.current
    if (pn && box) {
      const dx = e.clientX - pn.x, dy = e.clientY - pn.y
      if (Math.abs(dx) + Math.abs(dy) > 3) pn.moved = true
      if (pn.moved) { box.scrollLeft = pn.left - dx; box.scrollTop = pn.top - dy }
      return
    }
    const p = point(e)
    if (pending) setMouse(p)
    const b = bend.current
    if (b) {
      setCircuit(c => ({ ...c, wires: c.wires.map(w => (w.id === b.wire ? { ...w, via: (w.via ?? []).map((v, i) => (i === b.index ? { x: snap(p.x), y: snap(p.y) } : v)) } : w)) }))
      setDirty(true)
      return
    }
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
    const pn = pan.current
    pan.current = null
    // A click on empty space (not a drag to move the view) lets go of the wire being drawn and the selection.
    if (pn && !pn.moved) { setPending(null); setSelection(null) }
    bend.current = null
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const part = circuit.parts.find(p => p.id === d.id)
    // A click: a switch flips; a joint starts or ends a wire; anything else is selected.
    if (part?.kind === 'switch') change(c => ({ ...c, parts: c.parts.map(p => (p.id === part.id ? { ...p, on: !p.on } : p)) }))
    if (part?.kind === 'joint') {
      const ref = pinRef(part, 'p')
      if (pending && pending !== ref) { change(c => connect(c, pending, ref)); setPending(null) } else setPending(pending ? null : ref)
    }
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
    setCircuit(loadCircuit(await circuitLoad(f.project, f.name)))
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
      <button className={`ghost logic-menu-toggle${menu === 'open' ? ' active' : ''}`} onClick={() => { refreshFiles(); setMenu(m => (m === 'open' ? null : 'open')) }}><FolderOpen size={14} /> Open</button>
      <button className={`ghost logic-menu-toggle${menu === 'versions' ? ' active' : ''}`} title={menu ? undefined : 'Earlier saved versions of this circuit'} onClick={() => {
        if (menu !== 'versions' && isTauri()) void circuitVersions(file.project, file.name.trim()).then(setVersions).catch(() => setVersions([]))
        setMenu(m => (m === 'versions' ? null : 'versions'))
      }}><History size={14} /> Versions</button>
      <button className="ghost" onClick={fresh}><FilePlus size={14} /> New</button>
      <details className="logic-open logic-report">
        <summary className="ghost" title="A lab report: the circuit, truth table, K-maps, expressions, chips and wiring"><FileText size={14} /> Report</summary>
        <div className="logic-files">
          <button onClick={e => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; void run(async () => {
            const path = await reportSave(file.project, file.name.trim() || 'Circuit', reportHtml(circuit, { title: file.name.trim() || 'Circuit', project: file.project, date: new Date() }))
            await openPath(path)
            setMessage(`Lab report saved as ${path}. It opened in your browser: print it or save it as a PDF from there.`)
          }) }}><span>Open as a page</span><small>to print or save as a PDF</small></button>
          <button onClick={e => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; void toNote(`${file.name} – lab report`, reportMarkdown(circuit, { title: file.name, project: file.project, date: new Date() })) }}><span>Save as a note</span><small>to write it up in Notes</small></button>
        </div>
      </details>
      <div className="logic-view" role="tablist" aria-label="View">
        <button role="tab" aria-selected={view === 'schematic'} className={view === 'schematic' ? 'on' : ''} onClick={() => setView('schematic')}>Schematic</button>
        <button role="tab" aria-selected={view === 'breadboard'} className={view === 'breadboard' ? 'on' : ''} onClick={() => setView('breadboard')}>Breadboard</button>
        <button role="tab" aria-selected={view === 'fsm'} className={view === 'fsm' ? 'on' : ''} onClick={() => setView('fsm')} title="Design a state machine and build it with flip-flops">State machine</button>
      </div>
      <span className="grow" />
      <button className={`ghost${running ? ' active' : ''}`} onClick={() => setRunning(r => !r)} title="Run the clock parts">{running ? <Pause size={14} /> : <Play size={14} />} Clock</button>
      <select value={speed} onChange={e => setSpeed(Number(e.target.value))} title="Clock speed">
        <option value={0.5}>0.5 Hz</option><option value={1}>1 Hz</option><option value={2}>2 Hz</option><option value={5}>5 Hz</option>
      </select>
      <button className="ghost" disabled={!running} onClick={() => setClock(c => !c)} title="One clock edge">Step</button>
    </div>
    {message && <p className="hint logic-message">{message}</p>}
    {menu && <CircuitMenu mode={menu} files={files} versions={versions} file={file} onClose={() => setMenu(null)}
      loadFile={f => circuitLoad(f.project, f.name)} loadVersion={at => circuitVersionLoad(file.project, file.name.trim(), at)}
      onOpenFile={f => { setMenu(null); void open(f) }}
      onOpenVersion={at => { setMenu(null); void run(async () => {
        if (dirty && !window.confirm('Open an earlier version? Changes to the circuit on screen aren’t saved.')) return
        setCircuit(loadCircuit(await circuitVersionLoad(file.project, file.name.trim(), at)))
        setDirty(true)
        flops.current = {}
        setMessage(`Opened the version saved before ${new Date(at).toLocaleString()}. Save to keep it (the current one stays in Versions).`)
      }) }}
      onDelete={f => { if (window.confirm(`Delete ${f.name}?`)) void run(async () => { await circuitDelete(f.project, f.name); refreshFiles() }) }} />}
    {view === 'fsm' ? <div className="logic-main logic-main--wide"><FsmEditor fsm={circuit.fsm} onChange={fsm => change(c => ({ ...c, fsm }))}
      onBuild={fsm => { if (!circuit.parts.length || window.confirm('Replace the circuit on the canvas with this state machine’s?')) { setCircuit(buildFsmCircuit(fsm)); setDirty(true); flops.current = {}; setView('schematic'); setPanel('table') } }} /></div> :
    <div className="logic-main">
      <aside className="logic-palette">
        <h4>Inputs and outputs</h4>
        {INPUTS.map(item => <PaletteButton key={item.title} item={item} onAdd={add} />)}
        <h4>Gates <select value={inputs} onChange={e => setInputs(Number(e.target.value))} title="Inputs for new gates"><option value={2}>2 in</option><option value={3}>3 in</option><option value={4}>4 in</option></select></h4>
        {GATE_ITEMS.map(item => <PaletteButton key={item.title} item={item} onAdd={add} />)}
        <h4>74-series chips</h4>
        {CHIPS.map(c => <PaletteButton key={c.part} item={{ kind: 'chip', chip: c.part, title: `${c.part} · ${c.name}` }} onAdd={add} />)}
        <p className="hint">Click a pin, then another, to wire them. Drag parts to move them; R rotates the selected part; double-click a wire to bend it, and pick its shape above the canvas; Option/Alt-click a wire (or click one while drawing a wire) to put a joint there and branch from it; click a switch to flip it; Delete removes what’s selected. 14-pin chips need pin 14 to +5V and pin 7 to ground; 16-pin chips pin 16 and pin 8. Unconnected chip control inputs count as high, as on real TTL chips.</p>
      </aside>
      {view === 'breadboard' ? <div className="logic-canvas logic-canvas--board"><Breadboard circuit={circuit}
        levels={Object.fromEntries(circuit.parts.flatMap(p => p.label && (p.kind === 'switch' || p.kind === 'clock' || p.kind === 'led') ? [[p.label, sim.pins[pinRef(p, p.kind === 'led' ? 'in' : 'out')]]] : []))}
        onPlace={(ref, col) => change(c => ({ ...c, board: { ...(c.board ?? {}), [ref]: col } }))}
        onFlip={label => change(c => ({ ...c, parts: c.parts.map(p => (p.kind === 'switch' && p.label === label ? { ...p, on: !p.on } : p)) }))}
        onJumpers={next => change(c => ({ ...c, jumpers: next.length ? next : undefined }))} /></div> :
      <div className="logic-stage"><div ref={scroller} className="logic-canvas" onDragOver={e => e.preventDefault()} onDrop={e => {
        e.preventDefault()
        try { const item = JSON.parse(e.dataTransfer.getData('application/x-logic')) as PaletteItem; add(item, point(e)) } catch { /* not a part */ }
      }}>
        <svg ref={svg} width={W * zoom} height={H * zoom} viewBox={`0 0 ${W} ${H}`} onPointerMove={move} onPointerUp={up}
          onPointerDown={e => {
            const box = scroller.current
            if (!box || e.button !== 0) return
            pan.current = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false }
            ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
          }}>
          <defs><pattern id="logic-grid" width={20} height={20} patternUnits="userSpaceOnUse"><circle cx={1} cy={1} r={1} className="logic-dot" /></pattern></defs>
          <rect width={W} height={H} fill="url(#logic-grid)" />
          {circuit.wires.map(w => {
            const e = ends(w)
            if (!e) return null
            // Each source gets its own lane for the vertical run, so different signals don't overlap.
            const d = wirePath(w, e.from, e.to, circuit.parts.indexOf(e.src) % 6)
            const short = sim.shorts.includes(w.id)
            const sel = selection?.kind === 'wire' && selection.id === w.id
            return <g key={w.id} onPointerDown={ev => {
              ev.stopPropagation()
              // Option/Alt-click, or a click while drawing a wire: a joint there, to branch from.
              if (ev.altKey || pending) jointOn(w, point(ev))
              else setSelection({ kind: 'wire', id: w.id })
            }}
              onDoubleClick={ev => {
                // Double-click a wire: a bend point there, to drag it somewhere else.
                ev.stopPropagation()
                const at = point(ev)
                const pt = { x: snap(at.x), y: snap(at.y) }
                const i = bendIndex(w, e.A, e.B, pt)
                setWire(w.id, x => { const via = [...(x.via ?? [])]; via.splice(i, 0, pt); return { ...x, via } })
                setSelection({ kind: 'wire', id: w.id })
              }}>
              <path d={d} className="logic-wire-hit" />
              <path d={d} className={`logic-wire${sel ? ' selected' : ''}`} style={{ stroke: short ? 'var(--logic-short)' : levelColor(sim.pins[w.a]) }} />
              {sel && (w.via ?? []).map((v, i) => <rect key={i} x={v.x - 5} y={v.y - 5} width={10} height={10} rx={2} className="logic-bend"
                onPointerDown={ev => { ev.stopPropagation(); bend.current = { wire: w.id, index: i } }}
                onDoubleClick={ev => { ev.stopPropagation(); setWire(w.id, x => ({ ...x, via: (x.via ?? []).filter((_, j) => j !== i) })) }}>
                <title>Drag to move; double-click to remove</title></rect>)}
            </g>
          })}
          {circuit.parts.map(part => part.kind === 'joint' ? (() => {
            const ref = pinRef(part, 'p')
            const n = circuit.wires.filter(w => w.a === ref || w.b === ref).length
            const sel = selection?.kind === 'part' && selection.id === part.id
            return <g key={part.id} className={`logic-joint${sel ? ' selected' : ''}${pending === ref ? ' pending' : ''}`} onPointerDown={e => partDown(e, part)}>
              <circle cx={part.x} cy={part.y} r={9} className="logic-joint-hit" />
              <circle cx={part.x} cy={part.y} r={n >= 3 ? 5 : 4} style={{ fill: levelColor(sim.pins[ref]) }} />
              <title>Joint: click to start or end a wire here; drag to move; Delete removes it</title>
            </g>
          })() : <g key={part.id} onPointerDown={e => partDown(e, part)}>
            {(() => { const { w, h } = sizeOf(part); return <g transform={part.rot ? `rotate(${part.rot} ${part.x + w / 2} ${part.y + h / 2})` : undefined}>
              <PartShape part={part} level={level(part)} selected={selection?.kind === 'part' && selection.id === part.id} />
            </g> })()}
            {placedPins(part).filter(p => p.dir !== 'nc').map(pin => {
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
        </svg></div>
        {selection && (() => {
          const wire = selection.kind === 'wire' ? circuit.wires.find(w => w.id === selection.id) : null
          const shape: WireShape = wire?.shape ?? 'auto'
          return <div className="logic-selbar" onPointerDown={e => e.stopPropagation()}>
            {selection.kind === 'part' && circuit.parts.find(p => p.id === selection.id)?.kind !== 'joint' && <button onClick={() => rotate(selection.id)} title="Rotate a quarter turn (R)"><RotateCw size={13} /> Rotate</button>}
            {wire && <>
              <span title="Double-click the wire to add a bend, then drag it to reroute; double-click a bend to remove it">Wire</span>
              {([['auto', 'Right angles', CornerDownRight], ['straight', 'Straight', Minus], ['curved', 'Curved', Spline]] as const).map(([value, title, Icon]) =>
                <button key={value} className={shape === value ? 'on' : ''} onClick={() => setWire(wire.id, w => ({ ...w, shape: value }))} title={title}><Icon size={13} /> {title}</button>)}
              {!!wire.via?.length && <button onClick={() => setWire(wire.id, w => ({ ...w, via: undefined }))} title="Remove the bend points"><Eraser size={13} /> Clear bends</button>}
            </>}
            <button onClick={() => remove(selection)} title="Delete (Delete key)"><Trash2 size={13} /></button>
          </div>
        })()}
        <div className="logic-zoom" onPointerDown={e => e.stopPropagation()}>
          <button onClick={() => zoomTo(zoom / 1.2)} title="Zoom out (⌘/Ctrl + scroll, or pinch)"><ZoomOut size={14} /></button>
          <button className="logic-zoom__level" onClick={() => zoomTo(1)} title="Back to 100%">{Math.round(zoom * 100)}%</button>
          <button onClick={() => zoomTo(zoom * 1.2)} title="Zoom in"><ZoomIn size={14} /></button>
          <button onClick={fit} title="Fit the whole circuit in view"><Maximize size={14} /></button>
        </div>
        {!circuit.parts.length && <div className="logic-empty"><CircuitBoard size={28} /><p>Add switches, gates or chips from the left, then wire their pins. Or build one from an expression or a truth table on the right.</p></div>}
      </div>}
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
    </div>}
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
  const [rules, setRules] = useState<DesignRules>({ gates: 'any', maxInputs: 2 })
  /** Built from gate symbols, or from the ICs (74-series chips) wired pin by pin. */
  const [form, setForm] = useState<'gates' | 'chips'>('gates')
  const make = (c: Circuit) => (form === 'chips' ? asChips(c) : c)
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
        <RulesBar table={exprTable} rules={rules} onRules={setRules} form={form} onForm={setForm} />
        <div className="actions">
          <button onClick={() => onBuild(make(rules.gates === 'any' ? buildCircuit(parsed.outputs) : buildWithRules(exprTable, rules)))}><Wand2 size={13} /> Build the circuit</button>
          <button className="ghost" onClick={() => onNote('Truth table', tableMarkdown(exprTable, Object.fromEntries(parsed.outputs.map(o => [o.name, show(o.expr)]))))}><NotebookPen size={13} /> Save as a note</button>
        </div>
      </>}
    </> : <>
      <label className="logic-count">Inputs <select value={count} onChange={e => { const n = Number(e.target.value); setCount(n); setCells(c => Array.from({ length: 2 ** n }, (_, i) => c[i] ?? 0)) }}>{[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <p className="hint">Click an output to change it: 0, 1, or X (doesn’t matter).</p>
      <TableView table={filled} onCell={r => setCells(c => c.map((v, i) => (i === r ? (v === 0 ? 1 : v === 1 ? null : 0) : v)))} />
      <div className="logic-exprs"><strong>Y</strong> = {fromTable}</div>
      {kmapLayout(vars) && <KMapView table={filled} />}
      <RulesBar table={filled} rules={rules} onRules={setRules} form={form} onForm={setForm} />
      <div className="actions">
        <button onClick={() => onBuild(make(rules.gates === 'any' ? buildCircuit(parseOutputs(`Y = ${fromTable}`)) : buildWithRules(filled, rules)))}><Wand2 size={13} /> Build the circuit</button>
        <button className="ghost" onClick={() => onNote('Truth table', tableMarkdown(filled, { Y: fromTable }))}><NotebookPen size={13} /> Save as a note</button>
      </div>
    </>}
  </div>
}

/** Design rules (like a lab's "NAND gates only"): which gates, how many inputs each, both simplified
 *  forms, and what the circuit will take before it's built. */
function RulesBar({ table, rules, onRules, form, onForm }: { table: TruthTable; rules: DesignRules; onRules: (r: DesignRules) => void; form: 'gates' | 'chips'; onForm: (f: 'gates' | 'chips') => void }) {
  const sop = useMemo(() => expressions(table), [table])
  const pos = useMemo(() => posExpressions(table), [table])
  const summary = useMemo(() => designSummary(buildWithRules(table, rules)), [table, rules])
  const chips = Object.entries(summary.chips).map(([part, n]) => `${n}× ${part} (${chipDef(part)?.name ?? ''})`).join(', ')
  return <div className="logic-rules">
    <div className="logic-view logic-rules__form" role="tablist" aria-label="Build as">
      <button role="tab" aria-selected={form === 'gates'} className={form === 'gates' ? 'on' : ''} onClick={() => onForm('gates')}>Logic gates</button>
      <button role="tab" aria-selected={form === 'chips'} className={form === 'chips' ? 'on' : ''} onClick={() => onForm('chips')}>ICs (74-series chips)</button>
    </div>
    <div className="logic-rules__row">
      <label>Build with <select value={rules.gates} onChange={e => onRules({ ...rules, gates: e.target.value as DesignRules['gates'] })}>
        <option value="any">Any gates (AND, OR, NOT…)</option>
        <option value="nand">NAND gates only</option>
        <option value="nor">NOR gates only</option>
      </select></label>
      {rules.gates !== 'any' && <label>Inputs per gate <select value={rules.maxInputs} onChange={e => onRules({ ...rules, maxInputs: Number(e.target.value) as DesignRules['maxInputs'] })}>
        <option value={2}>2 (7400 / 7402)</option>
        <option value={3}>up to 3 (adds 7410 / 7427)</option>
        <option value={4}>up to 4 (adds 7420)</option>
      </select></label>}
    </div>
    {table.outputs.map(name => <div key={name} className="logic-exprs">
      <div><strong>{name}</strong> (SOP) = {sop[name]}</div>
      <div><strong>{name}</strong> (POS) = {pos[name]}</div>
    </div>)}
    <p className="hint">
      {rules.gates === 'nand' ? 'NAND–NAND from the sum of products; complemented inputs use a NAND with its inputs tied as an inverter. ' : rules.gates === 'nor' ? 'NOR–NOR from the product of sums; complemented inputs use a NOR with its inputs tied as an inverter. ' : ''}
      {summary.gates} gate{summary.gates === 1 ? '' : 's'}{summary.inverters ? ` (${summary.inverters} as inverter${summary.inverters === 1 ? '' : 's'})` : ''}{chips ? ` · chips: ${chips}` : ''}
    </p>
    {form === 'chips' && <p className="hint">Built as ICs: the chips go on the canvas with each pin wired, +5V and ground included (pin 14 and pin 7 on 14-pin chips), and spare gates’ inputs tied to ground.</p>}
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

/** Clock cycles from power-up, or gate delays: the nanoseconds after one switch flips. */
function TimingView({ circuit }: { circuit: Circuit }) {
  const [mode, setMode] = useState<'cycles' | 'delays'>('cycles')
  return <>
    <div className="logic-tabs small">
      <button className={mode === 'cycles' ? 'on' : ''} onClick={() => setMode('cycles')}>Clock cycles</button>
      <button className={mode === 'delays' ? 'on' : ''} onClick={() => setMode('delays')}>Gate delays</button>
    </div>
    {mode === 'cycles' ? <CyclesView circuit={circuit} /> : <DelaysView circuit={circuit} />}
  </>
}

/** What happens in the nanoseconds after a switch flips, with each gate's real delay: glitches show. */
function DelaysView({ circuit }: { circuit: Circuit }) {
  const switches = circuit.parts.filter(p => p.kind === 'switch' && p.label).map(p => p.label!).sort()
  const [flip, setFlip] = useState(switches[0] ?? '')
  const [gates, setGates] = useState(false)
  const label = switches.includes(flip) ? flip : switches[0]
  const run = useMemo(() => (label ? delayRun(circuit, label) : null), [circuit, label])
  if (!run) return <p className="hint">Add switches, gates and LEDs: this shows how a change on a switch travels through the gates, nanosecond by nanosecond.</p>
  const sw = circuit.parts.find(p => p.kind === 'switch' && p.label === label)
  const waves = run.waves.filter(w => gates || w.kind !== 'gate')
  const ROW = 30, LEFT = 56, WIDTH = 240, HIGH = 6, LOW = 22
  const x = (t: number) => LEFT + (t / run.end) * WIDTH
  const wave = (w: (typeof waves)[number]) => {
    let d = ''
    w.changes.forEach((ch, i) => {
      const y = ch.v === 1 ? HIGH : ch.v === 0 ? LOW : (HIGH + LOW) / 2
      d += i === 0 ? `M${LEFT},${y}` : ` H${x(ch.t)} V${y}`
    })
    return `${d} H${LEFT + WIDTH}`
  }
  const ticks = Array.from({ length: Math.floor(run.end / 10) + 1 }, (_, i) => i * 10).filter(t => run.end <= 100 || t % 20 === 0)
  return <div className="logic-timing">
    <div className="logic-delay-bar">
      <label className="logic-count">Flip <select value={label} onChange={e => setFlip(e.target.value)}>{switches.map(n => <option key={n} value={n}>{n}</option>)}</select> {sw?.on ? '1 → 0' : '0 → 1'}</label>
      <label className="logic-count"><input type="checkbox" checked={gates} onChange={e => setGates(e.target.checked)} /> Every gate</label>
    </div>
    <div className="logic-timing-scroll"><svg width={LEFT + WIDTH + 8} height={waves.length * ROW + 18}>
      {run.glitches.map((g, i) => <rect key={i} x={x(g.from) - 2} y={0} width={Math.max(4, x(g.to) - x(g.from) + 4)} height={waves.length * ROW} className="logic-glitch" />)}
      <line x1={x(run.flipAt)} x2={x(run.flipAt)} y1={0} y2={waves.length * ROW} className="logic-timing-edge" />
      {waves.map((w, r) => <g key={w.name + r} transform={`translate(0,${r * ROW})`}>
        <text x={0} y={18} className={`logic-timing-name ${w.kind === 'gate' ? 'in' : w.kind}`}>{w.name.length > 10 ? `${w.name.slice(0, 9)}…` : w.name}<title>{w.name}</title></text>
        <path d={wave(w)} className={`logic-timing-wave ${w.kind === 'gate' ? 'in' : w.kind}`} fill="none" />
      </g>)}
      {ticks.map(t => <text key={t} x={x(t)} y={waves.length * ROW + 12} className="logic-timing-tick" textAnchor="middle">{t}</text>)}
    </svg></div>
    <p className="hint">Nanoseconds after {label} flips (the dotted line), with typical 74LS delays: NOT, NAND, NOR 10 ns; AND, OR 15 ns; XOR 20 ns. Everything has settled {run.settled - run.flipAt} ns after the flip.</p>
    {run.glitches.length > 0 ? <ul className="logic-warnings">{run.glitches.map(g => <li key={g.name}>
      Glitch on {g.name} from {g.from} to {g.to} ns: {g.kind === 'static' ? `it should stay ${levelAt(run.waves.find(w => w.name === g.name)!, 0)} but flickers (a static hazard). Two product terms hand over to each other at different times; a K-map group overlapping both covers the handover and removes it.` : 'it changes more than once before settling (a dynamic hazard).'}
    </li>)}</ul> : <p className="hint">No glitches on the outputs for this change.</p>}
  </div>
}

/** Every clock, switch and LED over a number of clock cycles from power-up. */
function CyclesView({ circuit }: { circuit: Circuit }) {
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
