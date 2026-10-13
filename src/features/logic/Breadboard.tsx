import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Eraser, Trash2 } from 'lucide-react'
import { breadboard, checkWiring, parseSpot, ROWS_BOTTOM, ROWS_TOP, spotKey, spotName, stripOf, type Board, type Rail, type Spot } from './boardLayout'
import { newId, type BoardWire, type Circuit, type Level } from './model'

const P = 16 // hole pitch
const LEFT = 110 // room for the switches
const RIGHT = 110 // room for the LEDs
const Y = {
  'top+': 24, 'top-': 40,
  a: 76, b: 92, c: 108, d: 124, e: 140,
  f: 180, g: 196, h: 212, i: 228, j: 244,
  'bottom-': 280, 'bottom+': 296,
} as const
const HEIGHT = 330
const RAILS: Rail[] = ['top+', 'top-', 'bottom-', 'bottom+']
/** Jumper colours, as in a wire kit. */
const COLORS = ['#e0383e', '#1f1f1f', '#2f80ed', '#27ae60', '#f2c94c', '#f2994a', '#bb6bd9', '#f5f5f5']

const xOf = (col: number) => LEFT + (col - 1) * P
const railHole = (i: number) => i % 6 !== 5

/** The circuit as you'd build it on a breadboard: chips across the channel (drag one sideways to
 *  move it), power from the rails and a jumper per connection. Guide shows the wiring to make;
 *  Build it yourself lets you place the wires and checks them against the circuit. */
export default function Breadboard({ circuit, levels, onPlace, onFlip, onJumpers }: {
  circuit: Circuit
  /** Each switch's and LED's level, by label, from the simulation. */
  levels: Record<string, Level | undefined>
  onPlace: (ref: string, col: number) => void
  onFlip: (label: string) => void
  onJumpers: (next: BoardWire[]) => void
}) {
  const board: Board = useMemo(() => breadboard(circuit, circuit.board), [circuit])
  const mine = useMemo(() => circuit.jumpers ?? [], [circuit.jumpers])
  const check = useMemo(() => checkWiring(board, mine), [board, mine])
  const svg = useRef<SVGSVGElement>(null)
  const [mode, setMode] = useState<'guide' | 'build'>(() => (circuit.jumpers?.length ? 'build' : 'guide'))
  const [drag, setDrag] = useState<{ ref: string; dx: number; col: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  /** Build mode: the first end of the wire being placed, the spot under the pointer, the chosen wire. */
  const [pending, setPending] = useState<Spot | null>(null)
  const [over, setOver] = useState<Spot | null>(null)
  const [mouse, setMouse] = useState({ x: 0, y: 0 })
  const [picked, setPicked] = useState<string | null>(null)
  const [color, setColor] = useState(COLORS[2])
  const [ghost, setGhost] = useState(false)
  const build = mode === 'build'
  const width = LEFT + board.cols * P + RIGHT

  // Escape lets go of a wire; Delete removes the chosen one.
  useEffect(() => {
    if (!build) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      if (e.key === 'Escape') { setPending(null); setPicked(null) }
      if ((e.key === 'Delete' || e.key === 'Backspace') && picked) { e.preventDefault(); onJumpers(mine.filter(w => w.id !== picked)); setPicked(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [build, picked, mine, onJumpers])

  const ioY = (list: string[], label: string) => 86 + list.indexOf(label) * 44
  const at = (s: Spot): { x: number; y: number } =>
    s.kind === 'hole' ? { x: xOf(s.col), y: Y[s.row] }
      : s.kind === 'rail' ? { x: xOf(s.col), y: Y[s.rail] }
        : s.kind === 'switch' ? { x: LEFT - 36, y: ioY(board.inputs, s.label) }
          : { x: LEFT + board.cols * P + 20, y: ioY(board.outputs, s.label) }
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }
  const jumperPath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const bow = Math.min(60, 10 + Math.hypot(b.x - a.x, b.y - a.y) / 6)
    return `M${a.x},${a.y} Q${(a.x + b.x) / 2},${Math.min(a.y, b.y) - bow} ${b.x},${b.y}`
  }

  /** Build mode: a click on a spot starts a wire there, or ends the one being placed. */
  function tapSpot(s: Spot) {
    if (!build) return
    setPicked(null)
    if (!pending) { setPending(s); return }
    if (spotKey(pending) !== spotKey(s)) onJumpers([...mine, { id: newId('j'), a: spotKey(pending), b: spotKey(s), color }])
    setPending(null)
  }
  const spotProps = (s: Spot) => build ? {
    onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); tapSpot(s) },
    onPointerEnter: () => setOver(s),
    onPointerLeave: () => setOver(null),
  } : {}

  // The strip (or rail) under the pointer lights up, to show what a hole is joined to.
  const lit = over ? stripOf(over) : null
  const litStrip = lit && /^\d+[tb]$/.test(lit) ? { col: Number(lit.slice(0, -1)), top: lit.endsWith('t') } : null

  const allRight = check.total > 0 && !check.problems.length
  const ledLevel = (label: string) => (build && !allRight ? undefined : levels[label])

  return <div className="breadboard">
    <div className="bb-toolbar">
      <div className="logic-view" role="tablist" aria-label="Breadboard mode">
        <button role="tab" aria-selected={!build} className={!build ? 'on' : ''} onClick={() => { setMode('guide'); setPending(null); setPicked(null) }}>Guide</button>
        <button role="tab" aria-selected={build} className={build ? 'on' : ''} onClick={() => setMode('build')}>Build it yourself</button>
      </div>
      {build && <>
        <span className="bb-colors" role="radiogroup" aria-label="Wire colour">
          {COLORS.map(c => <button key={c} role="radio" aria-checked={color === c} className={color === c ? 'on' : ''} style={{ background: c }} title="Wire colour"
            onClick={() => { setColor(c); if (picked) onJumpers(mine.map(w => (w.id === picked ? { ...w, color: c } : w))) }} />)}
        </span>
        <label className="bb-ghost"><input type="checkbox" checked={ghost} onChange={e => setGhost(e.target.checked)} /> Show the guide</label>
        <button className="ghost" disabled={!board.jumpers.length} title="Start from the guide’s wiring, then change it"
          onClick={() => { if (!mine.length || window.confirm('Replace your wires with the guide’s?')) onJumpers(board.jumpers.map(j => ({ id: newId('j'), a: spotKey(j.a), b: spotKey(j.b), color: j.color }))) }}><Copy size={13} /> Copy the guide</button>
        {picked && <button className="ghost" onClick={() => { onJumpers(mine.filter(w => w.id !== picked)); setPicked(null) }} title="Remove this wire (Delete)"><Trash2 size={13} /> Remove wire</button>}
        <button className="ghost" disabled={!mine.length} onClick={() => { if (window.confirm('Take all your wires off the board?')) { onJumpers([]); setPicked(null) } }}><Eraser size={13} /> Clear</button>
      </>}
    </div>
    <div className="breadboard-scroll">
      <svg ref={svg} width={width} height={HEIGHT} className={build ? 'bb-build' : undefined}
        onPointerMove={e => {
          const p = local(e)
          if (pending) setMouse(p)
          if (drag) setDrag({ ...drag, col: Math.max(1, Math.round((p.x - drag.dx - LEFT) / P) + 1) })
        }}
        onPointerUp={() => { if (drag) onPlace(drag.ref, drag.col); setDrag(null) }}
        onPointerDown={() => { setPending(null); setPicked(null) }}>
        <rect x={LEFT - 18} y={8} width={board.cols * P + 20} height={HEIGHT - 16} rx={10} className="bb-board" />
        {litStrip && <rect x={xOf(litStrip.col) - 7} y={(litStrip.top ? Y.a : Y.f) - 7} width={14} height={Y.e - Y.a + 14} rx={4} className="bb-strip-lit" />}
        {/* Power rails: + red, − blue, top and bottom. */}
        {RAILS.map(rail => {
          const top = rail.startsWith('top'), plus = rail.endsWith('+')
          const ly = Y[rail] + (plus ? (top ? -9 : 9) : (top ? 9 : -9))
          const on = lit === (plus ? '+5V' : 'GND')
          return <g key={rail}>
            {on && <rect x={LEFT - 10} y={Y[rail] - 7} width={board.cols * P + 4} height={14} rx={4} className="bb-strip-lit" />}
            <line x1={LEFT - 8} x2={LEFT + board.cols * P - 8} y1={ly} y2={ly} className={plus ? 'bb-rail-plus' : 'bb-rail-minus'} />
            <text x={LEFT - 12} y={Y[rail] + 4} className="bb-label" textAnchor="end">{plus ? '+' : '−'}</text>
            {Array.from({ length: board.cols }, (_, i) => (railHole(i) ? <rect key={i} x={xOf(i + 1) - 3} y={Y[rail] - 3} width={6} height={6} rx={1} className="bb-hole" {...spotProps({ kind: 'rail', rail, col: i + 1 })} /> : null))}
          </g>
        })}
        {/* Terminal strips, with column numbers and row letters. */}
        {[...ROWS_TOP, ...ROWS_BOTTOM].map(row => <g key={row}>
          <text x={LEFT - 12} y={Y[row] + 4} className="bb-label" textAnchor="end">{row}</text>
          {Array.from({ length: board.cols }, (_, i) => <rect key={i} x={xOf(i + 1) - 3} y={Y[row] - 3} width={6} height={6} rx={1} className="bb-hole" {...spotProps({ kind: 'hole', row, col: i + 1 })} />)}
        </g>)}
        {Array.from({ length: board.cols }, (_, i) => ((i + 1) % 5 === 0 || i === 0 ? <text key={i} x={xOf(i + 1)} y={Y.a - 12} className="bb-label" textAnchor="middle">{i + 1}</text> : null))}
        <rect x={LEFT - 8} y={Y.e + 10} width={board.cols * P} height={Y.f - Y.e - 20} className="bb-channel" />

        {/* Switches on the left, LEDs on the right (the trainer's, off the board). */}
        {board.inputs.map(label => { const p = at({ kind: 'switch', label }); const on = levels[label] === 1; return <g key={label} className="bb-io">
          <g onClick={() => onFlip(label)}>
            <rect x={p.x - 54} y={p.y - 15} width={44} height={30} rx={6} className={`bb-switch${on ? ' on' : ''}`} />
            <text x={p.x - 32} y={p.y + 4} textAnchor="middle" className="bb-io-label">{label} {on ? 1 : 0}</text>
            <title>Switch {label}: click to flip</title>
          </g>
          <circle cx={p.x} cy={p.y} r={build ? 6 : 4} className="bb-terminal" {...spotProps({ kind: 'switch', label })}>{build && <title>Switch {label}’s terminal: click to wire it</title>}</circle>
        </g> })}
        {board.outputs.map(label => { const p = at({ kind: 'led', label }); const v = ledLevel(label); return <g key={label} className="bb-io">
          <circle cx={p.x} cy={p.y} r={build ? 6 : 4} className="bb-terminal" {...spotProps({ kind: 'led', label })}>{build && <title>LED {label}’s terminal: click to wire it</title>}</circle>
          <circle cx={p.x + 30} cy={p.y} r={11} className={`bb-led${v === 1 ? ' lit' : ''}${v === undefined ? ' unknown' : ''}`}>
            {v === undefined && <title>Finish the wiring (all connections right) to light it</title>}
          </circle>
          <text x={p.x + 52} y={p.y + 4} className="bb-io-label">{label}</text>
        </g> })}

        {/* Chips straddle the channel; drag one sideways to move it. */}
        {board.chips.map(ch => {
          const col = drag?.ref === ch.ref ? drag.col : ch.col
          const half = ch.pins / 2
          const x0 = xOf(col) - 7, x1 = xOf(col + half - 1) + 7
          return <g key={ch.ref} className={`bb-chip${drag?.ref === ch.ref ? ' dragging' : ''}`}
            onPointerDown={e => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ ref: ch.ref, dx: local(e).x - xOf(col), col }) }}>
            {Array.from({ length: half }, (_, i) => <g key={i}><rect x={xOf(col + i) - 2.5} y={Y.e - 2} width={5} height={8} className="bb-leg" /><rect x={xOf(col + i) - 2.5} y={Y.f - 6} width={5} height={8} className="bb-leg" /></g>)}
            <rect x={x0} y={Y.e + 4} width={x1 - x0} height={Y.f - Y.e - 8} rx={3} className="bb-chip-body" />
            <path d={`M${x0},${(Y.e + Y.f) / 2 - 6} a6,6 0 0 1 0,12`} className="bb-notch" />
            <text x={(x0 + x1) / 2} y={(Y.e + Y.f) / 2 - 2} textAnchor="middle" className="bb-chip-ref">{ch.ref}</text>
            <text x={(x0 + x1) / 2} y={(Y.e + Y.f) / 2 + 11} textAnchor="middle" className="bb-chip-part">{ch.part}</text>
            <title>{ch.ref}: {ch.part} {ch.name} (pin 1 at f{col}) · drag to move</title>
          </g>
        })}

        {/* The guide's jumpers: a bowed wire per connection, red for +5 V, black for ground. */}
        {!drag && (!build || ghost) && board.jumpers.map((j, i) => {
          const d = jumperPath(at(j.a), at(j.b))
          const dim = !build && hover && hover !== j.net
          return <g key={i} className={`bb-jumper${build ? ' ghost' : ''}`} opacity={build ? 0.22 : dim ? 0.15 : 1} onPointerEnter={() => setHover(j.net)} onPointerLeave={() => setHover(null)}>
            <path d={d} stroke="#0008" strokeWidth={5} fill="none" strokeLinecap="round" />
            <path d={d} stroke={j.color} strokeWidth={3} fill="none" strokeLinecap="round" />
            <circle cx={at(j.a).x} cy={at(j.a).y} r={2.5} fill={j.color} /><circle cx={at(j.b).x} cy={at(j.b).y} r={2.5} fill={j.color} />
            <title>{j.net}: {spotName(j.a)} → {spotName(j.b)}</title>
          </g>
        })}

        {/* Your wires. */}
        {build && !drag && mine.map(w => {
          const a = parseSpot(w.a), b = parseSpot(w.b)
          if (!a || !b) return null
          const pa = at(a), pb = at(b), d = jumperPath(pa, pb)
          const sel = picked === w.id
          return <g key={w.id} className={`bb-jumper mine${sel ? ' picked' : ''}`}
            onPointerDown={e => { e.stopPropagation(); setPending(null); setPicked(w.id); setColor(w.color) }}
            onDoubleClick={e => { e.stopPropagation(); onJumpers(mine.filter(x => x.id !== w.id)); setPicked(null) }}>
            <path d={d} stroke="transparent" strokeWidth={10} fill="none" />
            <path d={d} stroke={sel ? 'var(--accent)' : '#0008'} strokeWidth={sel ? 7 : 5} fill="none" strokeLinecap="round" />
            <path d={d} stroke={w.color} strokeWidth={3} fill="none" strokeLinecap="round" />
            <circle cx={pa.x} cy={pa.y} r={2.5} fill={w.color} /><circle cx={pb.x} cy={pb.y} r={2.5} fill={w.color} />
            <title>{spotName(a)} → {spotName(b)} · click to choose, double-click to remove</title>
          </g>
        })}
        {build && pending && (() => { const p = at(pending); return <path d={`M${p.x},${p.y} L${mouse.x},${mouse.y}`} stroke={color} strokeWidth={3} strokeDasharray="5 4" fill="none" pointerEvents="none" /> })()}
      </svg>
    </div>
    {!board.chips.length
      ? <p className="hint">Add gates or chips (or build from the Design panel): their chips appear here, placed on the board with the wiring to make.</p>
      : build ? <div className="bb-check">
        {pending ? <p className="hint">From {spotName(pending)}: click where the other end goes (Esc to stop).</p>
          : <p className="hint">Click a hole, then another, to put a wire between them. Hover a hole to see what it’s joined to: the five holes of its strip, or the whole rail. Click a wire to choose it (Delete removes it, a colour changes it).</p>}
        {allRight
          ? <p className="bb-check-ok"><Check size={14} /> All {check.total} connections are right. Flip the switches to try it.</p>
          : <>
            <p><strong>{check.right} of {check.total}</strong> connections right{check.problems.length ? `, ${check.problems.length} to fix` : ''}.</p>
            <ul>{check.problems.slice(0, 10).map(p => <li key={p} className={p.startsWith('Short') ? 'short' : undefined}>{p}</li>)}</ul>
            {check.problems.length > 10 && <p className="hint">And {check.problems.length - 10} more.</p>}
          </>}
      </div>
      : <details className="bb-steps" open>
        <summary>How to wire it ({board.steps.length} steps)</summary>
        <ol>{board.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        {board.notes.map(n => <p key={n} className="hint">{n}</p>)}
      </details>}
  </div>
}
