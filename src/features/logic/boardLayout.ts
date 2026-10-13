/** The circuit on a breadboard: its chips across the middle channel, power from the rails, and a
 *  jumper for each connection, as you'd build it on the lab bench (from chipPlan). */
import { chipDef, chipPlan, type BoardWire, type ChipPlan, type Circuit } from './model'

/** A full-size breadboard: 63 columns, rows a–e and f–j either side of the channel, two power
 *  rails (+ and −) along the top and the bottom. */
export const BOARD_COLS = 63
export const ROWS_TOP = ['a', 'b', 'c', 'd', 'e'] as const
export const ROWS_BOTTOM = ['f', 'g', 'h', 'i', 'j'] as const
export type Row = (typeof ROWS_TOP)[number] | (typeof ROWS_BOTTOM)[number]
export type Rail = 'top+' | 'top-' | 'bottom+' | 'bottom-'

/** A spot a jumper can go: a hole (column and row), a rail hole, or a switch or LED off the board. */
export type Spot = { kind: 'hole'; col: number; row: Row } | { kind: 'rail'; col: number; rail: Rail } | { kind: 'switch' | 'led'; label: string }
export type Jumper = { net: string; a: Spot; b: Spot; color: string }
export type BoardChip = { ref: string; part: string; name: string; pins: number; col: number }
/** One thing to do while building it: put a chip in, or place a jumper (its index in `jumpers`). */
export type BoardStep = { text: string; chip?: string; jumper?: number }
/** `cols`: the columns shown, the full board's or as many as the circuit uses (with room to spare). */
export type Board = { cols: number; chips: BoardChip[]; inputs: string[]; outputs: string[]; jumpers: Jumper[]; steps: BoardStep[]; notes: string[]; plan: ChipPlan }

/** Where each chip goes: column of pin 1 by chip (moved by hand), kept with the circuit. */
export type BoardPlacement = Record<string, number>

const SIGNAL_COLORS = ['#2f80ed', '#f2994a', '#27ae60', '#bb6bd9', '#f2c94c', '#56ccf2', '#eb5757', '#219653', '#9b51e0', '#828282']
const colorOf = (net: string, i: number) => (net === '+5V' ? '#e0383e' : net === 'GND' ? '#1f1f1f' : SIGNAL_COLORS[i % SIGNAL_COLORS.length])

export const spotName = (s: Spot) =>
  s.kind === 'hole' ? `${s.row}${s.col}` : s.kind === 'rail' ? `${s.rail.startsWith('top') ? 'top' : 'bottom'} ${s.rail.endsWith('+') ? '+5V' : 'ground'} rail (column ${s.col})` : s.kind === 'switch' ? `switch ${s.label}` : `LED ${s.label}`

/** Lays the circuit out on a breadboard. Chips go left to right with a gap, unless `placement` says
 *  where; each chip pin's jumpers use the free holes in its five-hole strip. */
export function breadboard(c: Circuit, placement: BoardPlacement = {}, plan: ChipPlan = chipPlan(c)): Board {
  const notes = [...plan.notes]
  const chips: BoardChip[] = []
  let next = 3
  for (const ch of plan.chips) {
    const pins = chipDef(ch.part)?.pins ?? 14
    const wide = pins / 2
    let col = placement[ch.ref] ?? next
    // Kept on the board and off other chips (each chip needs its columns to itself).
    col = Math.max(1, Math.min(col, BOARD_COLS - wide + 1))
    const clash = (at: number) => chips.some(o => at < o.col + o.pins / 2 + 1 && o.col < at + wide + 1)
    while (clash(col) && col + wide <= BOARD_COLS) col++
    if (clash(col)) { col = next; while (clash(col)) col++ }
    chips.push({ ref: ch.ref, part: ch.part, name: ch.name, pins, col })
    next = Math.max(next, col + wide + 3)
  }
  // Only the part of the board in use (and a little more), so the LEDs sit next to the chips.
  const cols = Math.min(BOARD_COLS, Math.max(24, ...chips.map(ch => ch.col + ch.pins / 2 + 4)))
  // Pin 1 bottom left (notch on the left): pins 1…n/2 in row f, the rest back along row e.
  const pinSpot = (ref: string, pin: number) => chipPinHole(chips, ref, pin)
  // Each strip of five holes has the chip leg in its row nearest the channel; jumpers take the others.
  const used = new Map<string, number>()
  const freeHole = (col: number, top: boolean): Spot => {
    const key = `${col}${top ? 't' : 'b'}`
    const n = used.get(key) ?? 0
    used.set(key, n + 1)
    const rows = top ? (['d', 'c', 'b', 'a'] as Row[]) : (['g', 'h', 'i', 'j'] as Row[])
    if (n >= rows.length) notes.push(`More than four wires on column ${col} (${top ? 'top' : 'bottom'}): use a short jumper to the next free strip.`)
    return { kind: 'hole', col, row: rows[Math.min(n, rows.length - 1)] }
  }

  type End = { spot: () => Spot; x: number; label: string }
  const inputs = new Set<string>(), outputs = new Set<string>()
  const jumpers: Jumper[] = []
  const steps: BoardStep[] = chips.map(ch => ({ text: `Put ${ch.ref} (${ch.part}) across the middle, notch left: pin 1 in f${ch.col}.`, chip: ch.ref }))
  steps.push({ text: 'Power supply: +5 V to both + rails, ground to both − rails.' })

  plan.connections.forEach((conn, i) => {
    const ends: End[] = []
    for (const text of conn.pins) {
      const chip = /^(U\d+) pin (\d+)/.exec(text)
      if (chip) {
        const at = pinSpot(chip[1], Number(chip[2]))
        if (at) ends.push({ spot: () => freeHole(at.col, at.row === 'e'), x: at.col, label: `${chip[1]} pin ${chip[2]}` })
        continue
      }
      const sw = /^(?:switch|clock) (.+)$/.exec(text)
      if (sw) { inputs.add(sw[1]); ends.push({ spot: () => ({ kind: 'switch', label: sw[1] }), x: 0, label: `switch ${sw[1]}` }); continue }
      const led = /^LED (\S+)/.exec(text)
      if (led) { outputs.add(led[1]); ends.push({ spot: () => ({ kind: 'led', label: led[1] }), x: cols + 1, label: `LED ${led[1]}` }) }
    }
    const color = colorOf(conn.net, i)
    if (conn.net === '+5V' || conn.net === 'GND') {
      // Power: each pin straight to the rail on its side of the board.
      for (const e of ends) {
        const a = e.spot()
        if (a.kind !== 'hole') continue
        const top = ROWS_TOP.includes(a.row as never)
        const rail: Rail = `${top ? 'top' : 'bottom'}${conn.net === '+5V' ? '+' : '-'}`
        const b: Spot = { kind: 'rail', col: a.col, rail }
        jumpers.push({ net: conn.net, a, b, color })
        steps.push({ text: `${conn.net === '+5V' ? '+5 V' : 'Ground'}: ${spotName(a)} → ${b.rail.endsWith('+') ? '+' : '−'} rail (${e.label})`, jumper: jumpers.length - 1 })
      }
      return
    }
    // A signal: its ends chained left to right, so the jumpers stay short.
    const sorted = [...ends].sort((p, q) => p.x - q.x)
    for (let k = 1; k < sorted.length; k++) {
      const a = sorted[k - 1].spot(), b = sorted[k].spot()
      jumpers.push({ net: conn.net, a, b, color })
      steps.push({ text: `${conn.net}: ${spotName(a)} → ${spotName(b)} (${sorted[k - 1].label} to ${sorted[k].label})`, jumper: jumpers.length - 1 })
    }
  })
  for (const led of outputs) steps.push({ text: `LED ${led}: through a 330 Ω resistor to ground (the trainer’s LEDs have one built in).` })
  return { cols, chips, inputs: [...inputs].sort(), outputs: [...outputs].sort(), jumpers, steps, notes, plan }
}

/** The hole a chip's pin sits in: pin 1 bottom left (notch on the left), pins 1…n/2 along row f,
 *  the rest back along row e. */
export function chipPinHole(chips: BoardChip[], ref: string, pin: number): { col: number; row: Row } | null {
  const ch = chips.find(x => x.ref === ref)
  if (!ch) return null
  const half = ch.pins / 2
  return pin <= half ? { col: ch.col + pin - 1, row: 'f' } : { col: ch.col + (ch.pins - pin), row: 'e' }
}

/** A spot as text, to save a hand-placed wire's ends: "c12", "top+@5", "sw:A", "led:Y". */
export const spotKey = (s: Spot): string =>
  s.kind === 'hole' ? `${s.row}${s.col}` : s.kind === 'rail' ? `${s.rail}@${s.col}` : `${s.kind === 'switch' ? 'sw' : 'led'}:${s.label}`

export function parseSpot(key: string): Spot | null {
  let m = /^([a-j])(\d{1,3})$/.exec(key)
  if (m) return { kind: 'hole', row: m[1] as Row, col: Number(m[2]) }
  m = /^(top|bottom)([+-])@(\d{1,3})$/.exec(key)
  if (m) return { kind: 'rail', rail: `${m[1]}${m[2]}` as Rail, col: Number(m[3]) }
  m = /^(sw|led):(.+)$/.exec(key)
  if (m) return { kind: m[1] === 'sw' ? 'switch' : 'led', label: m[2] }
  return null
}

/** What a spot is joined to without any wire: the five holes of its strip, or the whole rail.
 *  The power supply feeds both + rails and both − rails. */
export function stripOf(s: Spot): string {
  if (s.kind === 'hole') return `${s.col}${(ROWS_TOP as readonly string[]).includes(s.row) ? 't' : 'b'}`
  if (s.kind === 'rail') return s.rail.endsWith('+') ? '+5V' : 'GND'
  return `${s.kind}:${s.label}`
}

export type WiringCheck = { right: number; total: number; problems: string[] }

/** Checks wires placed by hand against the circuit: every connection made, and nothing joined that
 *  shouldn't be. */
export function checkWiring(board: Board, wires: BoardWire[]): WiringCheck {
  const parent = new Map<string, string>()
  const find = (x: string): string => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r }
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const w of wires) {
    const a = parseSpot(w.a), b = parseSpot(w.b)
    if (a && b) join(stripOf(a), stripOf(b))
  }
  type End = { node: string; label: string }
  const nets = board.plan.connections.map(conn => {
    const ends: End[] = []
    for (const text of conn.pins) {
      const chip = /^(U\d+) pin (\d+)/.exec(text)
      if (chip) {
        const at = chipPinHole(board.chips, chip[1], Number(chip[2]))
        if (at) ends.push({ node: stripOf({ kind: 'hole', ...at }), label: `${chip[1]} pin ${chip[2]} (${at.row}${at.col})` })
        continue
      }
      const sw = /^(?:switch|clock) (.+)$/.exec(text)
      if (sw) { ends.push({ node: `switch:${sw[1]}`, label: `switch ${sw[1]}` }); continue }
      const led = /^LED (\S+)/.exec(text)
      if (led) ends.push({ node: `led:${led[1]}`, label: `LED ${led[1]}` })
    }
    // Power: each pin to its rail (the rail first, so that's what a missing pin is said to need).
    if (conn.net === '+5V' || conn.net === 'GND') ends.unshift({ node: conn.net, label: conn.net === '+5V' ? 'the + rail' : 'the − rail' })
    return { net: conn.net, ends }
  })
  const problems: string[] = []
  const owner = new Map<string, string>()
  const shorted = new Set<string>()
  for (const { net, ends } of nets) {
    for (const e of ends) {
      const root = find(e.node)
      const other = owner.get(root)
      if (other && other !== net) {
        const pair = [other, net].sort().join(' and ')
        if (!shorted.has(pair)) problems.push(`Short: ${pair} are joined (at ${e.label}).`)
        shorted.add(pair)
        shorted.add(net)
        shorted.add(other)
      } else owner.set(root, net)
    }
  }
  let right = 0
  for (const { net, ends } of nets) {
    // The biggest group of this signal's ends that are joined; the rest aren't joined to it yet.
    const groups = new Map<string, End[]>()
    for (const e of ends) groups.set(find(e.node), [...(groups.get(find(e.node)) ?? []), e])
    const power = net === '+5V' || net === 'GND'
    const main = (power ? groups.get(find(ends[0].node)) : [...groups.values()].sort((a, b) => b.length - a.length)[0]) ?? []
    const missing = ends.filter(e => !main.includes(e))
    for (const e of missing) problems.push(`${net}: ${e.label} isn’t connected to ${main[0].label} yet.`)
    if (!missing.length && !shorted.has(net)) right++
  }
  return { right, total: nets.length, problems }
}
