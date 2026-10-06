/** Keyboard and mouse events from the viewer's canvas, in the form the host expects (remote/input.rs). */

export type InputEvent =
  | { t: 'move'; x: number; y: number }
  | { t: 'button'; button: 'left' | 'middle' | 'right'; down: boolean }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'key'; key: string; down: boolean }

/** Unshifted characters by physical key (US layout), so Shift is conveyed by the Shift key itself. */
const CODE_CHARS: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backquote: '`', Space: ' ',
}

export type KeyOptions = { hostIsMac: boolean; viewerIsMac: boolean; swapCommand: boolean }

/** The key name to send for a browser keyboard event, or null to ignore it. */
export function keyName(e: Pick<KeyboardEvent, 'key' | 'code'>, options: KeyOptions): string | null {
  let key = e.key
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase()
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (CODE_CHARS[e.code] !== undefined) key = CODE_CHARS[e.code]
  if (key === 'Dead' || key === 'Unidentified' || key === 'Process') return null
  // Shortcuts use Command on a Mac and Control on Windows: swap them so Ctrl+C here is Cmd+C there.
  if (options.swapCommand && options.hostIsMac !== options.viewerIsMac) {
    if (!options.hostIsMac && key === 'Meta') return 'Control'
    if (options.hostIsMac && key === 'Control') return 'Meta'
  }
  return key
}

export const buttonName = (button: number): 'left' | 'middle' | 'right' => button === 2 ? 'right' : button === 1 ? 'middle' : 'left'

/** Wheel deltas in pixels, whatever unit the browser used. */
export function wheelPixels(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1
  return { dx: e.deltaX * unit, dy: e.deltaY * unit }
}

/** Parses a packet from the viewer channel: `0` + JSON event, or `1` + header length + header + payload. */
export function parsePacket(data: ArrayBuffer | Uint8Array | number[]) {
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data)
  if (bytes[0] === 0) return { kind: 'event' as const, event: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) }
  const length = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(5, 5 + length))) as FrameHeader
  return { kind: 'frame' as const, header, payload: bytes.subarray(5 + length) }
}

export type FrameHeader =
  | { type: 'frame'; seq: number; width: number; height: number; tiles: Array<{ x: number; y: number; w: number; h: number; len: number }>; bytes: number }
  /** H.264 (Annex B); `key` frames decode on their own. */
  | { type: 'video'; seq: number; width: number; height: number; key: boolean; bytes: number }
  /** 16-bit little-endian samples, interleaved; `rate` 0 means the host can't capture sound. */
  | { type: 'audio'; rate: number; channels: number; bytes: number }
