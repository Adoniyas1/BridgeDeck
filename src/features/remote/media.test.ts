import { describe, expect, it } from 'vitest'
import { codecString, nalUnits, nextStart, pcmChannels } from './media'

describe('remote media', () => {
  it('reads the codec from a key frame', () => {
    const frame = new Uint8Array([0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x28, 0xaa, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 1, 0x65, 0x88])
    expect(nalUnits(frame).map(n => n.type)).toEqual([7, 8, 5])
    expect(codecString(frame)).toBe('avc1.4d4028')
    expect(codecString(new Uint8Array([0, 0, 0, 1, 0x41, 0x9a]))).toBeNull()
  })

  it('turns samples into channels and schedules them', () => {
    const bytes = new Uint8Array(new Int16Array([16384, -32768, 0, 32767]).buffer)
    const [left, right] = pcmChannels(bytes, 2)
    expect([...left]).toEqual([0.5, 0])
    expect(right[0]).toBe(-1)
    expect(right[1]).toBeCloseTo(1, 3)
    expect(nextStart(10, 10.1)).toBe(10.1)
    expect(nextStart(10, 9)).toBeCloseTo(10.06)
    expect(nextStart(10, 11)).toBeCloseTo(10.06)
  })
})
