/** Ready-made circuits to start from: the usual lab ones. Combinational ones are built from their
 *  expressions; counters, shift registers and detectors are state machines built on 7474 flip-flops
 *  (and open in the state machine designer too). */
import { buildFsmCircuit, type Bit, type Fsm, type FsmState, type FsmTransition } from './fsm'
import { buildCircuit, minimize, newId, parseOutputs, type Circuit } from './model'

export type Example = { id: string; group: 'Combinational' | 'Sequential'; title: string; about: string; build: () => Circuit }

const fromText = (text: string) => buildCircuit(parseOutputs(text))

/** BCD (0–9) on B3 B2 B1 B0 to the seven segments A–G of a common-cathode display (10–15 don't matter). */
export function sevenSegment(): string {
  // Which digits light each segment.
  const lit: Record<string, number[]> = {
    A: [0, 2, 3, 5, 6, 7, 8, 9], B: [0, 1, 2, 3, 4, 7, 8, 9], C: [0, 1, 3, 4, 5, 6, 7, 8, 9], D: [0, 2, 3, 5, 6, 8, 9],
    E: [0, 2, 6, 8], F: [0, 4, 5, 6, 8, 9], G: [2, 3, 4, 5, 6, 8, 9],
  }
  const dc = [10, 11, 12, 13, 14, 15]
  return Object.entries(lit).map(([seg, on]) => `${seg} = ${minimize(['B3', 'B2', 'B1', 'B0'], on, dc)}`).join('\n')
}

const st = (id: string, name: string, x: number, y: number, out: Record<string, Bit> = {}): FsmState => ({ id, name, x, y, out })
const to = (from: string, dest: string, when: string, out: Record<string, Bit> = {}): FsmTransition => ({ id: newId('t'), from, to: dest, when, out })

/** A counter through n states with outputs showing the count in binary (bits named Q1, Q0…). */
function counter(n: number, upDown = false): Fsm {
  const bits = Math.max(1, Math.ceil(Math.log2(n)))
  const outputs = Array.from({ length: bits }, (_, i) => `C${bits - 1 - i}`)
  const states = Array.from({ length: n }, (_, k) => {
    const angle = (2 * Math.PI * k) / n - Math.PI / 2
    return st(`s${k}`, `S${k}`, Math.round(400 + 220 * Math.cos(angle)), Math.round(300 + 200 * Math.sin(angle)), Object.fromEntries(outputs.map((o, i) => [o, ((k >> (bits - 1 - i)) & 1) as Bit])))
  })
  const transitions = states.flatMap((_, k) => (upDown ? [to(`s${k}`, `s${(k + 1) % n}`, '1'), to(`s${k}`, `s${(k + n - 1) % n}`, '0')] : [to(`s${k}`, `s${(k + 1) % n}`, '')]))
  return { kind: 'moore', inputs: upDown ? ['U'] : [], outputs, states, transitions, start: 's0' }
}

/** A 2-bit shift register: each clock, D moves into Q1 and Q1 into Q0. */
function shiftRegister(): Fsm {
  const pos: Array<[number, number]> = [[200, 160], [560, 160], [200, 440], [560, 440]]
  const states = [0, 1, 2, 3].map(k => st(`s${k}`, `Q${(k >> 1) & 1}${k & 1}`, pos[k][0], pos[k][1], { Q1: ((k >> 1) & 1) as Bit, Q0: (k & 1) as Bit }))
  const transitions = [0, 1, 2, 3].flatMap(k => [0, 1].map(d => to(`s${k}`, `s${(d << 1) | ((k >> 1) & 1)}`, String(d))))
  return { kind: 'moore', inputs: ['D'], outputs: ['Q1', 'Q0'], states, transitions, start: 's0' }
}

/** Red → green → yellow → red, one step per clock. */
function trafficLight(): Fsm {
  return {
    kind: 'moore', inputs: [], outputs: ['R', 'Y', 'G'],
    states: [st('r', 'Red', 220, 200, { R: 1, Y: 0, G: 0 }), st('g', 'Green', 580, 200, { R: 0, Y: 0, G: 1 }), st('y', 'Yellow', 400, 460, { R: 0, Y: 1, G: 0 })],
    transitions: [to('r', 'g', ''), to('g', 'y', ''), to('y', 'r', '')],
    start: 'r',
  }
}

/** Z = 1 for one step after the input has been 1, 0, 1 (overlapping, Mealy). */
function detector101(): Fsm {
  return {
    kind: 'mealy', inputs: ['X'], outputs: ['Z'],
    states: [st('a', 'Start', 160, 220), st('b', 'Got 1', 420, 220), st('c', 'Got 10', 680, 220)],
    transitions: [to('a', 'a', '0', { Z: 0 }), to('a', 'b', '1', { Z: 0 }), to('b', 'b', '1', { Z: 0 }), to('b', 'c', '0', { Z: 0 }), to('c', 'a', '0', { Z: 0 }), to('c', 'b', '1', { Z: 1 })],
    start: 'a',
  }
}

export const EXAMPLES: Example[] = [
  { id: 'half-adder', group: 'Combinational', title: 'Half adder', about: 'S = A ⊕ B, C = AB', build: () => fromText('S = A ^ B\nC = A B') },
  { id: 'full-adder', group: 'Combinational', title: 'Full adder', about: 'Adds A, B and a carry in (C)', build: () => fromText('S = A ^ B ^ C\nCO = A B + C (A ^ B)') },
  { id: 'mux', group: 'Combinational', title: '2-to-1 multiplexer', about: 'Y = A when S is 0, B when S is 1', build: () => fromText("Y = S' A + S B") },
  { id: 'decoder', group: 'Combinational', title: '2-to-4 decoder', about: 'One output on for each input pair', build: () => fromText("Y0 = A' B'\nY1 = A' B\nY2 = A B'\nY3 = A B") },
  { id: 'comparator', group: 'Combinational', title: '1-bit comparator', about: 'A > B, A = B, A < B', build: () => fromText("G = A B'\nE = (A ^ B)'\nL = A' B") },
  { id: 'majority', group: 'Combinational', title: 'Majority vote', about: 'On when at least two of three are on', build: () => fromText('Y = A B + A C + B C') },
  { id: 'parity', group: 'Combinational', title: 'Even parity bit', about: 'Makes the count of 1s even', build: () => fromText('P = A ^ B ^ C ^ D') },
  { id: 'seven-seg', group: 'Combinational', title: 'BCD to 7-segment', about: 'Inputs B3–B0 (0–9) → segments A–G', build: () => fromText(sevenSegment()) },
  { id: 'counter-4', group: 'Sequential', title: '2-bit counter (0–3)', about: 'Counts up each clock', build: () => buildFsmCircuit(counter(4)) },
  { id: 'counter-3', group: 'Sequential', title: 'Mod-3 counter (0–2)', about: 'Counts 0, 1, 2 and starts over', build: () => buildFsmCircuit(counter(3)) },
  { id: 'counter-8', group: 'Sequential', title: '3-bit counter (0–7)', about: 'Counts up each clock', build: () => buildFsmCircuit(counter(8)) },
  { id: 'updown', group: 'Sequential', title: 'Up/down counter', about: 'U = 1 counts up, 0 counts down', build: () => buildFsmCircuit(counter(4, true)) },
  { id: 'shift', group: 'Sequential', title: '2-bit shift register', about: 'D shifts into Q1, Q1 into Q0', build: () => buildFsmCircuit(shiftRegister()) },
  { id: 'traffic', group: 'Sequential', title: 'Traffic light', about: 'Red, green, yellow in turn', build: () => buildFsmCircuit(trafficLight()) },
  { id: 'detect-101', group: 'Sequential', title: '101 sequence detector', about: 'Mealy: Z = 1 when it sees 1, 0, 1', build: () => buildFsmCircuit(detector101()) },
]
