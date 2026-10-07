import { chipDef, pinsOf, SEG7_PINS, sizeOf, type Level, type Part } from './model'

export const levelColor = (v: Level | undefined) => (v === 1 ? 'var(--logic-high)' : v === 0 ? 'var(--logic-low)' : 'var(--logic-unknown)')

/** The standard (ANSI) gate shapes in a 60 × h box; inverting gates get a bubble. */
function GateShape({ part, h }: { part: Part; h: number }) {
  const gate = part.gate ?? 'AND'
  const bubble = gate === 'NOT' || gate === 'NAND' || gate === 'NOR' || gate === 'XNOR'
  const body = gate === 'NOT' || gate === 'BUF' ? 50 : bubble ? 50 : 60
  let d: string
  if (gate === 'AND' || gate === 'NAND') d = `M0,0 H${body - h / 2} A${h / 2},${h / 2} 0 0 1 ${body - h / 2},${h} H0 Z`
  else if (gate === 'OR' || gate === 'NOR' || gate === 'XOR' || gate === 'XNOR') {
    const x0 = gate === 'XOR' || gate === 'XNOR' ? 8 : 0
    d = `M${x0},0 Q${x0 + 14},${h / 2} ${x0},${h} Q${body * 0.6},${h} ${body},${h / 2} Q${body * 0.6},0 ${x0},0 Z`
  } else d = `M0,0 L${body},${h / 2} L0,${h} Z`
  return <>
    <path d={d} className="logic-body" />
    {(gate === 'XOR' || gate === 'XNOR') && <path d={`M0,0 Q14,${h / 2} 0,${h}`} className="logic-line" fill="none" />}
    {bubble && <circle cx={body + 5} cy={h / 2} r={5} className="logic-body" />}
    <line x1={bubble ? body + 10 : body} y1={h / 2} x2={70} y2={h / 2} className="logic-line" />
    <text x={body / 2 - 4} y={h / 2 + 4} className="logic-gate-name" textAnchor="middle">{gate === 'BUF' ? '' : gate}</text>
    {pinsOf(part).filter(p => p.dir === 'in').map(p => <line key={p.name} x1={-10} y1={p.y} x2={gate.endsWith('OR') ? 6 : 0} y2={p.y} className="logic-line" />)}
  </>
}

/** A 74-series chip seen from above: notch on the left, pin 1 bottom left. */
function ChipShape({ part }: { part: Part }) {
  const def = chipDef(part.chip)
  const { w, h } = sizeOf(part)
  return <>
    <rect x={0} y={0} width={w} height={h} rx={4} className="logic-chip" />
    <path d={`M0,${h / 2 - 8} A8,8 0 0 1 0,${h / 2 + 8}`} className="logic-notch" />
    <text x={w / 2} y={h / 2 - 2} className="logic-chip-name" textAnchor="middle">{def?.part ?? '?'}</text>
    <text x={w / 2} y={h / 2 + 11} className="logic-chip-sub" textAnchor="middle">{def?.name ?? ''}</text>
    {pinsOf(part).map(p => {
      const top = p.y < 0
      return <g key={p.name}>
        <line x1={p.x} y1={top ? 0 : h} x2={p.x} y2={p.y} className="logic-line" />
        <text x={p.x} y={top ? 9 : h - 3} className="logic-pin-label" textAnchor="middle">{p.label ?? ''}</text>
        <text x={p.x + 5} y={top ? p.y - 2 : p.y + 9} className="logic-pin-number">{p.name}</text>
      </g>
    })}
  </>
}

/** Segment outlines in a 60 × 90 display (a top, then clockwise, g in the middle). */
const SEGMENT_PATHS: Record<string, string> = {
  a: 'M18,10 H46 L42,15 H22 Z', b: 'M48,12 V42 L43,38 V17 Z', c: 'M48,48 V78 L43,73 V52 Z', d: 'M18,80 H46 L42,75 H22 Z',
  e: 'M16,48 V78 L21,73 V52 Z', f: 'M16,12 V42 L21,38 V17 Z', g: 'M18,45 L22,42 H42 L46,45 L42,48 H22 Z',
}

/** A 7-segment display: a segment lights on 1, or on 0 for a common-anode display (as a 7447 drives). */
function Seg7Shape({ part, level }: { part: Part; level: (pin: string) => Level | undefined }) {
  const { w, h } = sizeOf(part)
  const litOn = part.on ? 0 : 1
  return <>
    <rect width={w} height={h} rx={6} className="logic-seg7" />
    {SEG7_PINS.map(seg => {
      const v = level(seg)
      return <path key={seg} d={SEGMENT_PATHS[seg]} className="logic-segment" style={{ fill: v === litOn ? 'var(--logic-led-on)' : v === null || v === undefined ? 'var(--logic-unknown)' : 'var(--logic-segment-off)', filter: v === litOn ? 'drop-shadow(0 0 3px var(--logic-led-on))' : undefined }} />
    })}
    {pinsOf(part).map(p => <g key={p.name}><line x1={-10} y1={p.y} x2={0} y2={p.y} className="logic-line" /><text x={3} y={p.y + 3} className="logic-pin-label">{p.name}</text></g>)}
    <text x={w / 2} y={-6} className="logic-label" textAnchor="middle">{part.label}</text>
    <text x={w / 2} y={h + 12} className="logic-small" textAnchor="middle">{part.on ? 'common anode' : 'common cathode'}</text>
  </>
}

/** One part, drawn at its place, with its pins. */
export function PartShape({ part, level, selected }: { part: Part; level: (pin: string) => Level | undefined; selected: boolean }) {
  const { w, h } = sizeOf(part)
  const on = (pin: string) => level(pin) === 1
  let body: JSX.Element
  switch (part.kind) {
    case 'gate': body = <GateShape part={part} h={h} />; break
    case 'chip': body = <ChipShape part={part} />; break
    case 'seg7': body = <Seg7Shape part={part} level={level} />; break
    case 'switch':
      body = <>
        <rect width={w} height={h} rx={8} className={`logic-switch${part.on ? ' on' : ''}`} />
        <rect x={part.on ? w - 20 : 4} y={h / 2 - 8} width={16} height={16} rx={4} className="logic-knob" />
        <text x={w / 2} y={-6} className="logic-label" textAnchor="middle">{part.label}</text>
        <line x1={w} y1={h / 2} x2={w + 10} y2={h / 2} className="logic-line" />
        <text x={w / 2} y={h + 12} className="logic-small" textAnchor="middle">{part.on ? '1' : '0'}</text>
      </>
      break
    case 'clock':
      body = <>
        <rect width={w} height={h} rx={6} className="logic-body" />
        <path d={`M6,${h - 12} H14 V12 H22 V${h - 12} H30 V12 H34`} className="logic-line" fill="none" stroke={levelColor(level('out'))} />
        <text x={w / 2} y={-6} className="logic-label" textAnchor="middle">{part.label}</text>
        <line x1={w} y1={h / 2} x2={w + 10} y2={h / 2} className="logic-line" />
      </>
      break
    case 'led': {
      const v = level('in')
      body = <>
        <circle cx={w / 2} cy={h / 2} r={16} className="logic-led" style={{ fill: v === 1 ? 'var(--logic-led-on)' : v === 0 ? 'var(--logic-led-off)' : 'var(--logic-unknown)', filter: v === 1 ? 'drop-shadow(0 0 6px var(--logic-led-on))' : undefined }} />
        <text x={w / 2} y={-6} className="logic-label" textAnchor="middle">{part.label}</text>
        <text x={w / 2} y={h / 2 + 4} className="logic-small dark" textAnchor="middle">{v === null || v === undefined ? '?' : v}</text>
        <line x1={-10} y1={h / 2} x2={w / 2 - 16} y2={h / 2} className="logic-line" />
      </>
      break
    }
    case 'vcc':
      body = <>
        <rect width={w} height={h} rx={6} className="logic-power" />
        <text x={w / 2} y={h / 2 + 4} className="logic-small" textAnchor="middle">+5V</text>
        <line x1={w} y1={h / 2} x2={w + 10} y2={h / 2} className="logic-line" />
      </>
      break
    case 'gnd':
      body = <>
        <rect width={w} height={h} rx={6} className="logic-body" />
        <path d={`M${w / 2 - 10},${h / 2 - 2} H${w / 2 + 10} M${w / 2 - 6},${h / 2 + 3} H${w / 2 + 6} M${w / 2 - 2},${h / 2 + 8} H${w / 2 + 2} M${w / 2},${h / 2 - 2} V${h / 2 - 10}`} className="logic-line" />
        <text x={w / 2} y={-6} className="logic-label" textAnchor="middle">GND</text>
        <line x1={w} y1={h / 2} x2={w + 10} y2={h / 2} className="logic-line" />
      </>
      break
  }
  return <g transform={`translate(${part.x},${part.y})`} className={selected ? 'logic-part selected' : 'logic-part'} data-on={on('out') ? 1 : 0}>
    {selected && <rect x={-14} y={-18} width={w + 28} height={h + 36} rx={8} className="logic-selection" />}
    {body}
  </g>
}
