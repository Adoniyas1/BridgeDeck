/** The AI speed chart's data: each answer's tokens per second (Mimir's speed.log) and the moments the
 *  GPU share changed (Mimir's activity.log: the load watch easing off, or auto-tune picking one). */

export type SpeedSample = { at: number; model: string; tokens: number; tps: number }
export type ShareChange = { at: number; share: number; why: string }

export function parseSpeed(text: string): SpeedSample[] {
  return text.split('\n').flatMap(line => {
    const [time, model, tokens, tps] = line.split('\t')
    const at = Date.parse(time ?? '')
    const t = Number(tps)
    return Number.isFinite(at) && Number.isFinite(t) && model ? [{ at, model, tokens: Number(tokens) || 0, tps: t }] : []
  })
}

export function parseShareChanges(text: string): ShareChange[] {
  return text.split('\n').flatMap(line => {
    const m = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\] (.*)$/.exec(line)
    if (!m) return []
    const at = Date.parse(`${m[1]}T${m[2]}Z`)
    const msg = m[3]
    let r: RegExpExecArray | null
    if ((r = /GPU share \d+% → (\d+)%/.exec(msg))) return [{ at, share: Number(r[1]), why: 'Eased off the GPU (computer under pressure)' }]
    if ((r = /^Auto-tune: Kept (\d+)% on the GPU/.exec(msg))) return [{ at, share: Number(r[1]), why: 'Auto-tune' }]
    return []
  })
}
