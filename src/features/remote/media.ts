/** Video and sound in a remote tab: H.264 decoded with WebCodecs, sound played with Web Audio. */

export const H264_PROBE = 'avc1.4D4028'

/** Whether this web view can decode H.264 frames (WebView2 and Safari 16.4+ can). */
export async function h264Supported(): Promise<boolean> {
  try {
    if (typeof VideoDecoder === 'undefined') return false
    const result = await VideoDecoder.isConfigSupported({ codec: H264_PROBE, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
    return !!result.supported
  } catch { return false }
}

/** The NAL units' starts and types in an Annex B frame. */
export function nalUnits(bytes: Uint8Array): Array<{ type: number; start: number }> {
  const out: Array<{ type: number; start: number }> = []
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      out.push({ type: bytes[i + 3] & 0x1f, start: i + 3 })
      i += 2
    }
  }
  return out
}

/** The codec string for a stream ("avc1.4d4028") from the SPS in a key frame, if it has one. */
export function codecString(bytes: Uint8Array): string | null {
  const sps = nalUnits(bytes).find(n => n.type === 7)
  if (!sps || sps.start + 3 >= bytes.length) return null
  const hex = (b: number) => b.toString(16).padStart(2, '0')
  return `avc1.${hex(bytes[sps.start + 1])}${hex(bytes[sps.start + 2])}${hex(bytes[sps.start + 3])}`
}

/** 16-bit little-endian interleaved samples as one float array per channel. */
export function pcmChannels(bytes: Uint8Array, channels: number): Float32Array<ArrayBuffer>[] {
  const count = Math.floor(bytes.length / 2 / Math.max(1, channels))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = Array.from({ length: channels }, () => new Float32Array(count))
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < channels; c++) out[c][i] = view.getInt16((i * channels + c) * 2, true) / 32768
  }
  return out
}

/** When the next chunk should start: right after the last, unless that fell behind or ran too far ahead. */
export function nextStart(now: number, scheduled: number, lead = 0.06, maxAhead = 0.35) {
  if (scheduled < now + 0.01 || scheduled > now + maxAhead) return now + lead
  return scheduled
}

/** Plays chunks of sound back to back with a small lead, dropping latency when it builds up. */
export class SoundPlayer {
  private context: AudioContext | null = null
  private at = 0

  play(bytes: Uint8Array, rate: number, channels: number) {
    if (!rate || !channels || !bytes.length) return
    const context = this.context ??= new AudioContext({ latencyHint: 'interactive' })
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    const data = pcmChannels(bytes, channels)
    if (!data[0].length) return
    const buffer = context.createBuffer(channels, data[0].length, rate)
    data.forEach((samples, c) => buffer.copyToChannel(samples, c))
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const start = nextStart(context.currentTime, this.at)
    source.start(start)
    this.at = start + buffer.duration
  }

  close() {
    void this.context?.close().catch(() => undefined)
    this.context = null
    this.at = 0
  }
}
