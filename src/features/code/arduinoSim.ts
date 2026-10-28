import { AVRIOPort, AVRTimer, AVRUSART, CPU, PinState, avrInstruction, portBConfig, portCConfig, portDConfig, timer0Config, timer1Config, timer2Config, usart0Config } from 'avr8js'

/**
 * An Arduino Uno in software (avr8js: the ATmega328P's CPU, timers, serial port and pins), running a
 * compiled sketch at its real 16 MHz. Pins are named as on the board: D0–D13 and A0–A5.
 */

export const CLOCK_HZ = 16_000_000
const FLASH_BYTES = 32 * 1024

/** An Intel HEX file (what the compiler writes) as the chip's program memory. */
export function parseHex(text: string): Uint16Array {
  const bytes = new Uint8Array(FLASH_BYTES)
  let base = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (!line.startsWith(':')) throw new Error('That isn’t a HEX file')
    const n = parseInt(line.slice(1, 3), 16)
    const addr = parseInt(line.slice(3, 7), 16)
    const type = parseInt(line.slice(7, 9), 16)
    if (type === 0x00) {
      for (let i = 0; i < n; i++) {
        const at = base + addr + i
        if (at >= FLASH_BYTES) throw new Error('The program is bigger than an Uno’s 32 KB')
        bytes[at] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16)
      }
    } else if (type === 0x02) base = parseInt(line.slice(9, 13), 16) * 16
    else if (type === 0x04) base = parseInt(line.slice(9, 13), 16) * 65536
    else if (type === 0x01) break
  }
  return new Uint16Array(bytes.buffer)
}

/** The Uno's pins, D0–D13 then A0–A5, as port and bit. */
export const PINS: Array<{ name: string; port: 'B' | 'C' | 'D'; bit: number }> = [
  ...Array.from({ length: 8 }, (_, i) => ({ name: `D${i}`, port: 'D' as const, bit: i })),
  ...Array.from({ length: 6 }, (_, i) => ({ name: `D${i + 8}`, port: 'B' as const, bit: i })),
  ...Array.from({ length: 6 }, (_, i) => ({ name: `A${i}`, port: 'C' as const, bit: i })),
]

export type PinLevel = 'high' | 'low' | 'input' | 'pullup'

export class Uno {
  readonly cpu: CPU
  readonly ports: Record<'B' | 'C' | 'D', AVRIOPort>
  readonly usart: AVRUSART
  private readonly timers: AVRTimer[]
  /** Typed text waiting to go in: the serial port takes one byte at a time. */
  private incoming: number[] = []
  /** Pins something outside drives (a button, a wire): the rest float, so a pulled-up input reads high. */
  private driven = new Map<string, boolean>()
  /** Called with each piece of text the sketch prints to Serial. */
  onSerial: (text: string) => void = () => undefined

  constructor(hex: string) {
    this.cpu = new CPU(parseHex(hex))
    this.timers = [timer0Config, timer1Config, timer2Config].map(c => new AVRTimer(this.cpu, c))
    this.ports = { B: new AVRIOPort(this.cpu, portBConfig), C: new AVRIOPort(this.cpu, portCConfig), D: new AVRIOPort(this.cpu, portDConfig) }
    this.usart = new AVRUSART(this.cpu, usart0Config, CLOCK_HZ)
    this.usart.onByteTransmit = b => this.onSerial(String.fromCharCode(b))
    this.usart.onRxComplete = () => this.feed()
  }

  private feed() {
    if (this.incoming.length && !this.usart.rxBusy) this.usart.writeByte(this.incoming.shift()!)
  }

  /** Runs the chip for this many clock cycles (16 000 000 a second). */
  run(cycles: number) {
    const until = this.cpu.cycles + cycles
    while (this.cpu.cycles < until) {
      this.float()
      // Pins are looked at every 0.1 ms of chip time; the chip runs in between.
      const step = Math.min(until, this.cpu.cycles + 1600)
      while (this.cpu.cycles < step) {
        avrInstruction(this.cpu)
        this.cpu.tick()
      }
    }
  }

  /** Inputs nothing drives read as their pull-up makes them: high with it on, low without. */
  private float() {
    for (const p of PINS) {
      if (this.driven.has(p.name)) continue
      const port = this.ports[p.port]
      const pulled = port.pinState(p.bit) === PinState.InputPullUp
      if (port.pinState(p.bit) === PinState.Input || pulled) port.setPin(p.bit, pulled)
    }
  }

  /** Simulated time since reset, in seconds. */
  get seconds() { return this.cpu.cycles / CLOCK_HZ }

  pin(name: string): PinLevel {
    const p = PINS.find(x => x.name === name)
    if (!p) throw new Error(`No pin ${name}`)
    const s = this.ports[p.port].pinState(p.bit)
    return s === PinState.High ? 'high' : s === PinState.Low ? 'low' : s === PinState.InputPullUp ? 'pullup' : 'input'
  }

  /** A button or wire on an input pin: high or low; null lets it float again. */
  setInput(name: string, high: boolean | null) {
    const p = PINS.find(x => x.name === name)
    if (!p) return
    if (high === null) this.driven.delete(name)
    else { this.driven.set(name, high); this.ports[p.port].setPin(p.bit, high) }
  }

  /** Text typed into the serial monitor, sent to the sketch. */
  send(text: string) {
    for (const ch of text) this.incoming.push(ch.charCodeAt(0) & 0xff)
    this.feed()
  }
}
