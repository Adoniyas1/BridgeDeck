/// <reference lib="webworker" />
// Straightens and whitens a page photo off the main thread (study/warp.ts).
// In: { data: Uint8ClampedArray (RGBA), width, height, corners, out: {width, height}, whiten }.
// Out: { data, width, height } or { error }.
import { warp, whiten, type Pt } from './warp'

self.onmessage = (e: MessageEvent<{ data: Uint8ClampedArray; width: number; height: number; corners: Pt[]; out: { width: number; height: number }; whiten: boolean }>) => {
  try {
    const { data, width, height, corners, out } = e.data
    const flat = warp({ data, width, height }, corners, out.width, out.height)
    if (e.data.whiten) whiten({ data: flat, width: out.width, height: out.height })
    ;(self as unknown as Worker).postMessage({ data: flat, width: out.width, height: out.height }, [flat.buffer])
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
