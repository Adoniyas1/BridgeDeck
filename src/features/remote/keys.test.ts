import { describe, expect, it } from 'vitest'
import { buttonName, keyName, parsePacket, wheelPixels } from './keys'

const win2mac = { hostIsMac: true, viewerIsMac: false, swapCommand: true }

describe('remote input', () => {
  it('sends physical keys unshifted and named keys by name', () => {
    expect(keyName({ key: 'A', code: 'KeyA' }, win2mac)).toBe('a')
    expect(keyName({ key: '!', code: 'Digit1' }, win2mac)).toBe('1')
    expect(keyName({ key: '?', code: 'Slash' }, win2mac)).toBe('/')
    expect(keyName({ key: 'Enter', code: 'Enter' }, win2mac)).toBe('Enter')
    expect(keyName({ key: 'Dead', code: 'Quote' }, win2mac)).toBe("'")
    expect(keyName({ key: 'Dead', code: 'IntlRo' }, win2mac)).toBeNull()
  })

  it('swaps Control and Command between Windows and Mac', () => {
    expect(keyName({ key: 'Control', code: 'ControlLeft' }, win2mac)).toBe('Meta')
    expect(keyName({ key: 'Meta', code: 'MetaLeft' }, { hostIsMac: false, viewerIsMac: true, swapCommand: true })).toBe('Control')
    expect(keyName({ key: 'Control', code: 'ControlLeft' }, { ...win2mac, swapCommand: false })).toBe('Control')
    expect(keyName({ key: 'Control', code: 'ControlLeft' }, { hostIsMac: true, viewerIsMac: true, swapCommand: true })).toBe('Control')
  })

  it('maps buttons and wheel units', () => {
    expect([0, 1, 2].map(buttonName)).toEqual(['left', 'middle', 'right'])
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 0, dy: 120 })
  })

  it('parses channel packets', () => {
    const json = new TextEncoder().encode('{"type":"ended","reason":"Stopped"}')
    expect(parsePacket(new Uint8Array([0, ...json]))).toEqual({ kind: 'event', event: { type: 'ended', reason: 'Stopped' } })
    const header = new TextEncoder().encode(JSON.stringify({ type: 'frame', seq: 1, width: 2, height: 2, tiles: [{ x: 0, y: 0, w: 2, h: 2, len: 2 }], bytes: 2 }))
    const packet = new Uint8Array([1, 0, 0, 0, header.length, ...header, 9, 9])
    const parsed = parsePacket(packet.buffer)
    expect(parsed.kind).toBe('frame')
    if (parsed.kind === 'frame' && parsed.header.type === 'frame') {
      expect(parsed.header.tiles[0].len).toBe(2)
      expect([...parsed.payload]).toEqual([9, 9])
    }
  })
})
