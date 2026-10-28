/**
 * Circuits that need a real simulator: ngspice (through EEcircuit's WebAssembly build) for what
 * the homework solver (lib/mna.ts) can't do: time (`.tran`), frequency sweeps (`.ac dec …`, for
 * Bode plots), DC sweeps, and diodes, transistors, op-amp models. The netlist is ngspice's own.
 */

import type { ResultType } from 'eecircuit-engine'

/** Whether a netlist needs ngspice rather than the homework solver: an analysis the solver doesn't
 *  have, or a part it doesn't (anything but R, C, L, V, I). */
export function needsNgspice(text: string): boolean {
  const lines = text.split('\n').map(l => l.replace(/[;*].*$|\/\/.*$/, '').trim()).filter(Boolean)
  return lines.some(l => /^\.(tran|dc|op|model|include|subckt|lib|param|meas|measure)\b/i.test(l)
    || /^\.ac\s+(dec|oct|lin)\b/i.test(l)
    || (/^[a-z]/i.test(l) && !/^[rclvi?]/i.test(l))
    || /\b(pulse|sin|pwl|exp|sffm)\s*\(/i.test(l))
}

/** The netlist as ngspice takes it: a title first, the solver's "?" lines out, units ngspice
 *  reads ("10uF" is fine; "4.7kΩ" and "5∠30°" aren't), and `.end` last. */
export function toNgspice(text: string): string {
  const lines = text.split('\n')
    .map(l => l.replace(/\/\/.*$/, '').replace(/[Ωω]/g, '').replace(/µ/g, 'u'))
    .filter(l => !l.trim().startsWith('?') && !/^\s*\.end\s*$/i.test(l))
  return ['* BridgeDeck circuit', ...lines, '.end'].join('\n')
}

export type Trace = { name: string; values: number[] }
export type SpiceResult =
  | { kind: 'time' | 'sweep'; x: { name: string; values: number[] }; traces: Trace[] }
  | { kind: 'freq'; x: { name: string; values: number[] }; traces: Trace[]; phases: Trace[] }
  | { kind: 'point'; values: Array<{ name: string; value: number }> }

/** "v(out)" → "V(out)", "i(v1)" → "I(V1)". */
const label = (name: string) => name.replace(/^([vi])\((.*)\)$/i, (_, k: string, n: string) => k.toLowerCase() === 'i' ? `I(${n.toUpperCase()})` : `V(${n})`)

/** What the simulator gave back, as things to draw: voltages over time or a swept value, gain (dB)
 *  and phase over frequency, or the values at one operating point. */
export function readResult(r: ResultType): SpiceResult {
  if (r.dataType === 'complex') {
    const [freq, ...rest] = r.data
    const signals = rest.filter(d => d.type === 'voltage' || d.type === 'current')
    return {
      kind: 'freq',
      x: { name: 'Frequency', values: freq.values.map(v => v.real) },
      traces: signals.map(d => ({ name: label(d.name), values: d.values.map(v => 20 * Math.log10(Math.max(1e-30, Math.hypot(v.real, v.img)))) })),
      phases: signals.map(d => ({ name: label(d.name), values: unwrap(d.values.map(v => Math.atan2(v.img, v.real) * 180 / Math.PI)) })),
    }
  }
  const [first, ...rest] = r.data
  if (r.numPoints <= 1 || first.type !== 'time' && rest.length === 0) {
    return { kind: 'point', values: r.data.map(d => ({ name: label(d.name), value: d.values[0] })) }
  }
  return { kind: first.type === 'time' ? 'time' : 'sweep', x: { name: first.type === 'time' ? 'Time' : label(first.name), values: first.values }, traces: rest.map(d => ({ name: label(d.name), values: d.values })) }
}

/** Phase without the 360° jumps. */
function unwrap(deg: number[]): number[] {
  const out: number[] = []
  let shift = 0
  deg.forEach((d, i) => {
    if (i > 0) { const step = d + shift - out[i - 1]; if (step > 180) shift -= 360; else if (step < -180) shift += 360 }
    out.push(d + shift)
  })
  return out
}

/** The traces worth showing first: node voltages before currents, and not a source's own node
 *  when it's just the input (kept when it's all there is). */
export function shownTraces(traces: Trace[], max = 6): Trace[] {
  const volts = traces.filter(t => t.name.startsWith('V('))
  const amps = traces.filter(t => t.name.startsWith('I('))
  return [...volts, ...amps].slice(0, max)
}

/** The lines ngspice said that matter: warnings and errors (not its chatter). */
export function problems(lines: string[]): string[] {
  return [...new Set(lines.map(l => l.trim()).filter(l => /\b(warning|error|fatal|singular|not found|unknown|ignored|failed)\b/i.test(l)))].slice(0, 8)
}

/** Where the gain is 3 dB below its low-frequency value: a filter's cutoff (null if it never is). */
export function cutoff(freq: number[], gainDb: number[]): number | null {
  if (freq.length < 2) return null
  const target = gainDb[0] - 3.0103
  for (let i = 1; i < freq.length; i++) {
    if ((gainDb[i - 1] - target) * (gainDb[i] - target) <= 0 && gainDb[i] !== gainDb[i - 1]) {
      // Interpolated on a log frequency scale.
      const t = (target - gainDb[i - 1]) / (gainDb[i] - gainDb[i - 1])
      return 10 ** (Math.log10(freq[i - 1]) + t * (Math.log10(freq[i]) - Math.log10(freq[i - 1])))
    }
  }
  return null
}
