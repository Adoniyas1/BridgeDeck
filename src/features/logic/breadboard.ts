/** The circuit on a breadboard: its chips across the middle channel, power from the rails, and a
 *  jumper for each connection, as you'd build it on the lab bench (from chipPlan). */
import { chipDef, chipPlan, type ChipPlan, type Circuit } from './model'

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
export type Board = { cols: number; chips: BoardChip[]; inputs: string[]; outputs: string[]; jumpers: Jumper[]; steps: string[]; notes: string[] }

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
  const cols = Math.max(BOARD_COLS, ...chips.map(ch => ch.col + ch.pins / 2 + 2))
  // Pin 1 bottom left (notch on the left): pins 1…n/2 in row f, the rest back along row e.
  const pinSpot = (ref: string, pin: number): { col: number; row: Row } | null => {
    const ch = chips.find(x => x.ref === ref)
    if (!ch) return null
    const half = ch.pins / 2
    return pin <= half ? { col: ch.col + pin - 1, row: 'f' } : { col: ch.col + (ch.pins - pin), row: 'e' }
  }
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
  const steps: string[] = chips.map(ch => `Put ${ch.ref} (${ch.part}, ${ch.name}) across the middle channel with its notch to the left: pin 1 in f${ch.col}, pin ${ch.pins} in e${ch.col}.`)
  steps.push('Connect the power supply: +5 V to the + rails and ground to the − rails, top and bottom.')

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
        steps.push(`${conn.net === '+5V' ? '+5 V' : 'Ground'}: ${e.label} — ${spotName(a)} to the ${spotName(b)}.`)
      }
      return
    }
    // A signal: its ends chained left to right, so the jumpers stay short.
    const sorted = [...ends].sort((p, q) => p.x - q.x)
    for (let k = 1; k < sorted.length; k++) {
      const a = sorted[k - 1].spot(), b = sorted[k].spot()
      jumpers.push({ net: conn.net, a, b, color })
      steps.push(`${conn.net}: ${sorted[k - 1].label} — ${spotName(a)} to ${spotName(b)} (${sorted[k].label}).`)
    }
  })
  for (const led of outputs) steps.push(`LED ${led}: through a 330 Ω resistor to ground (the trainer's LEDs have one built in).`)
  return { cols, chips, inputs: [...inputs].sort(), outputs: [...outputs].sort(), jumpers, steps, notes }
}
