import { useMemo, useRef, useState } from 'react'
import { breadboard, ROWS_BOTTOM, ROWS_TOP, spotName, type Board, type Spot } from './breadboard'
import type { Circuit, Level } from './model'

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

const xOf = (col: number) => LEFT + (col - 1) * P

/** The circuit as you'd build it on a breadboard: chips across the channel (drag one sideways to
 *  move it), power from the rails, a coloured jumper per connection, and the steps in order. */
export default function Breadboard({ circuit, levels, onPlace, onFlip }: {
  circuit: Circuit
  /** Each switch's and LED's level, by label, from the simulation. */
  levels: Record<string, Level | undefined>
  onPlace: (ref: string, col: number) => void
  onFlip: (label: string) => void
}) {
  const board: Board = useMemo(() => breadboard(circuit, circuit.board), [circuit])
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ ref: string; dx: number; col: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const width = LEFT + board.cols * P + RIGHT

  const ioY = (list: string[], label: string) => 86 + list.indexOf(label) * 44
  const at = (s: Spot): { x: number; y: number } =>
    s.kind === 'hole' ? { x: xOf(s.col), y: Y[s.row] }
      : s.kind === 'rail' ? { x: xOf(s.col), y: Y[s.rail] }
        : s.kind === 'switch' ? { x: LEFT - 36, y: ioY(board.inputs, s.label) }
          : { x: LEFT + board.cols * P + 20, y: ioY(board.outputs, s.label) }
  const svgX = (e: React.PointerEvent) => e.clientX - (svg.current?.getBoundingClientRect().left ?? 0)

  return <div className="breadboard">
    <div className="breadboard-scroll">
      <svg ref={svg} width={width} height={HEIGHT}
        onPointerMove={e => { if (drag) setDrag({ ...drag, col: Math.max(1, Math.round((svgX(e) - drag.dx - LEFT) / P) + 1) }) }}
        onPointerUp={() => { if (drag) onPlace(drag.ref, drag.col); setDrag(null) }}>
        <rect x={LEFT - 18} y={8} width={board.cols * P + 20} height={HEIGHT - 16} rx={10} className="bb-board" />
        {/* Power rails: + red, − blue, top and bottom. */}
        {(['top+', 'top-', 'bottom-', 'bottom+'] as const).map(rail => <g key={rail}>
          <line x1={LEFT - 8} x2={LEFT + board.cols * P - 8} y1={Y[rail] + (rail.endsWith('+') ? (rail.startsWith('top') ? -9 : 9) : (rail.startsWith('top') ? 9 : -9))} y2={Y[rail] + (rail.endsWith('+') ? (rail.startsWith('top') ? -9 : 9) : (rail.startsWith('top') ? 9 : -9))} className={rail.endsWith('+') ? 'bb-rail-plus' : 'bb-rail-minus'} />
          <text x={LEFT - 12} y={Y[rail] + 4} className="bb-label" textAnchor="end">{rail.endsWith('+') ? '+' : '−'}</text>
          {Array.from({ length: board.cols }, (_, i) => (i % 6 === 5 ? null : <rect key={i} x={xOf(i + 1) - 3} y={Y[rail] - 3} width={6} height={6} rx={1} className="bb-hole" />))}
        </g>)}
        {/* Terminal strips, with column numbers and row letters. */}
        {[...ROWS_TOP, ...ROWS_BOTTOM].map(row => <g key={row}>
          <text x={LEFT - 12} y={Y[row] + 4} className="bb-label" textAnchor="end">{row}</text>
          {Array.from({ length: board.cols }, (_, i) => <rect key={i} x={xOf(i + 1) - 3} y={Y[row] - 3} width={6} height={6} rx={1} className="bb-hole" />)}
        </g>)}
        {Array.from({ length: board.cols }, (_, i) => ((i + 1) % 5 === 0 || i === 0 ? <text key={i} x={xOf(i + 1)} y={Y.a - 12} className="bb-label" textAnchor="middle">{i + 1}</text> : null))}
        <rect x={LEFT - 8} y={Y.e + 10} width={board.cols * P} height={Y.f - Y.e - 20} className="bb-channel" />

        {/* Switches on the left, LEDs on the right (the trainer's, off the board). */}
        {board.inputs.map(label => { const p = at({ kind: 'switch', label }); const on = levels[label] === 1; return <g key={label} className="bb-io" onClick={() => onFlip(label)}>
          <rect x={p.x - 54} y={p.y - 15} width={44} height={30} rx={6} className={`bb-switch${on ? ' on' : ''}`} />
          <text x={p.x - 32} y={p.y + 4} textAnchor="middle" className="bb-io-label">{label} {on ? 1 : 0}</text>
          <circle cx={p.x} cy={p.y} r={4} className="bb-terminal" /><title>Switch {label}: click to flip</title>
        </g> })}
        {board.outputs.map(label => { const p = at({ kind: 'led', label }); const lit = levels[label] === 1; return <g key={label} className="bb-io">
          <circle cx={p.x} cy={p.y} r={4} className="bb-terminal" />
          <circle cx={p.x + 30} cy={p.y} r={11} className={`bb-led${lit ? ' lit' : ''}`} />
          <text x={p.x + 52} y={p.y + 4} className="bb-io-label">{label}</text>
        </g> })}

        {/* Chips straddle the channel; drag one sideways to move it. */}
        {board.chips.map(ch => {
          const col = drag?.ref === ch.ref ? drag.col : ch.col
          const half = ch.pins / 2
          const x0 = xOf(col) - 7, x1 = xOf(col + half - 1) + 7
          return <g key={ch.ref} className={`bb-chip${drag?.ref === ch.ref ? ' dragging' : ''}`}
            onPointerDown={e => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag({ ref: ch.ref, dx: svgX(e) - xOf(col), col }) }}>
            {Array.from({ length: half }, (_, i) => <g key={i}><rect x={xOf(col + i) - 2.5} y={Y.e - 2} width={5} height={8} className="bb-leg" /><rect x={xOf(col + i) - 2.5} y={Y.f - 6} width={5} height={8} className="bb-leg" /></g>)}
            <rect x={x0} y={Y.e + 4} width={x1 - x0} height={Y.f - Y.e - 8} rx={3} className="bb-chip-body" />
            <path d={`M${x0},${(Y.e + Y.f) / 2 - 6} a6,6 0 0 1 0,12`} className="bb-notch" />
            <text x={(x0 + x1) / 2} y={(Y.e + Y.f) / 2 - 2} textAnchor="middle" className="bb-chip-ref">{ch.ref}</text>
            <text x={(x0 + x1) / 2} y={(Y.e + Y.f) / 2 + 11} textAnchor="middle" className="bb-chip-part">{ch.part}</text>
            <title>{ch.ref}: {ch.part} {ch.name} (pin 1 at f{col}) · drag to move</title>
          </g>
        })}

        {/* Jumpers: a bowed wire per connection, red for +5 V, black for ground. */}
        {!drag && board.jumpers.map((j, i) => {
          const a = at(j.a), b = at(j.b)
          const dist = Math.hypot(b.x - a.x, b.y - a.y)
          const bow = Math.min(60, 10 + dist / 6)
          const d = `M${a.x},${a.y} Q${(a.x + b.x) / 2},${Math.min(a.y, b.y) - bow} ${b.x},${b.y}`
          const dim = hover && hover !== j.net
          return <g key={i} className="bb-jumper" opacity={dim ? 0.15 : 1} onPointerEnter={() => setHover(j.net)} onPointerLeave={() => setHover(null)}>
            <path d={d} stroke="#0008" strokeWidth={5} fill="none" strokeLinecap="round" />
            <path d={d} stroke={j.color} strokeWidth={3} fill="none" strokeLinecap="round" />
            <circle cx={a.x} cy={a.y} r={2.5} fill={j.color} /><circle cx={b.x} cy={b.y} r={2.5} fill={j.color} />
            <title>{j.net}: {spotName(j.a)} → {spotName(j.b)}</title>
          </g>
        })}
      </svg>
    </div>
    {!board.chips.length
      ? <p className="hint">Add gates or chips (or build from the Design panel): their chips appear here, placed on the board with the wiring to make.</p>
      : <details className="bb-steps" open>
        <summary>How to wire it ({board.steps.length} steps)</summary>
        <ol>{board.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        {board.notes.map(n => <p key={n} className="hint">{n}</p>)}
      </details>}
  </div>
}
