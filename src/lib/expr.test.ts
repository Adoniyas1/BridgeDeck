import { describe, expect, it } from 'vitest'
import { bandsFor, engineering, evaluate, formatQuantity, resistorFromBands, runLines } from './expr'

const show = (text: string) => formatQuantity(evaluate(text))

describe('engineering arithmetic', () => {
  it('reads prefixes and units and keeps track of them', () => {
    expect(show('4.7k')).toBe('4700')
    expect(show('2k2 ohm')).toBe('2.2 kΩ')
    expect(show('12V / 2.2kΩ')).toBe('5.455 mA')
    expect(show('10uF * 4.7kohm')).toBe('47 ms')
    expect(show('3mA * 2kΩ')).toBe('6 V')
    expect(show('1/(2pi * 1kHz * 10uF)')).toBe('15.92 Ω')
    expect(() => evaluate('1V + 1A')).toThrow('Can’t add V and A')
  })
  it('does complex numbers, phasors and parallel', () => {
    expect(show('3+4j')).toBe('3 + j4 = 5 ∠ 53.13°')
    expect(show('abs(3+4j)')).toBe('5')
    expect(show('5∠90°')).toBe('j5 = 5 ∠ 90°')
    expect(show('1k || 1k')).toBe('500')
    expect(show('-5∠-90')).toBe('j5 = 5 ∠ 90°')
    expect(show('1kΩ || 1kΩ')).toBe('500 Ω')
    expect(show('100Ω || 1/(j 2pi 1kHz 1uF)')).toMatch(/Ω = .* ∠ -32\.14°$/)
  })
  it('keeps names set earlier apart from units', () => {
    expect(runLines('C = 10uF\nf = 1kHz\n1/(2pi f C)').map(l => l.result)).toEqual(['10 µF', '1 kHz', '15.92 Ω'])
  })
  it('works through a block line by line', () => {
    const out = runLines('R1 = 4.7k ohm\nR2 = 10k ohm\nVin = 5V\n# divider\nVin * R2 / (R1 + R2)\nnope\nred red brown gold')
    expect(out.map(l => l.result ?? l.error ?? '')).toEqual(['4.7 kΩ', '10 kΩ', '5 V', '', '3.401 V', 'Unknown name “nope”', '220 Ω ±5%'])
  })
  it('reads and makes resistor colour bands', () => {
    expect(resistorFromBands('yellow violet red gold')).toBe('4.7 kΩ ±5%')
    expect(resistorFromBands('brown black black red brown')).toBe('10 kΩ ±1%')
    expect(resistorFromBands('the red car')).toBeNull()
    expect(bandsFor(4700)).toBe('yellow violet red')
    expect(bandsFor(220)).toBe('red red brown')
    expect(engineering(0.000047, 'F')).toBe('47 µF')
  })
})
