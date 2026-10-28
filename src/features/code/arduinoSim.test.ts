import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CLOCK_HZ, parseHex, Uno } from './arduinoSim'

// A real AVR program (fixtures/uno-test.c): hello on serial, D13 toggling every 100 ms, and typed
// letters echoed in upper case with D2's level after each.
const HEX = readFileSync(fileURLToPath(new URL('./fixtures/uno-test.hex', import.meta.url)), 'utf8')

describe('the simulated Arduino Uno', () => {
  it('reads HEX files and refuses other things', () => {
    const flash = parseHex(':0400000001020304F2\n:00000001FF\n')
    expect(flash[0]).toBe(0x0201)
    expect(flash[1]).toBe(0x0403)
    expect(() => parseHex('void setup() {}')).toThrow(/HEX/)
  })

  it('runs a compiled program at 16 MHz: serial out, blinking pin, serial in, input pins', () => {
    const uno = new Uno(HEX)
    let out = ''
    uno.onSerial = t => { out += t }
    uno.run(CLOCK_HZ * 0.02)
    expect(out).toBe('hello\n')

    // D13 toggles every 100 ms of simulated time.
    const seen = new Set<string>()
    for (let i = 0; i < 6; i++) { uno.run(CLOCK_HZ * 0.05); seen.add(uno.pin('D13')) }
    expect([...seen].sort()).toEqual(['high', 'low'])
    expect(uno.seconds).toBeGreaterThan(0.3)
    expect(uno.pin('D2')).toBe('pullup')

    // Typed text goes in a byte at a time; D2 reads high (pulled up), then low when pulled down.
    out = ''
    uno.send('ab')
    uno.run(CLOCK_HZ * 0.05)
    expect(out).toBe('A1B1')
    uno.setInput('D2', false)
    out = ''
    uno.send('c')
    uno.run(CLOCK_HZ * 0.05)
    expect(out).toBe('C0')
  })
})
