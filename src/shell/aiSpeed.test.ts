import { describe, expect, it } from 'vitest'
import { parseShareChanges, parseSpeed } from './aiSpeed'

describe('AI speed log', () => {
  it('reads the speed samples and the GPU share changes', () => {
    expect(parseSpeed('2026-10-15T10:00:00.000Z\tqwen\t100\t25.0\nbroken line\n')).toEqual([{ at: Date.parse('2026-10-15T10:00:00Z'), model: 'qwen', tokens: 100, tps: 25 }])
    const log = [
      '[2026-10-15 10:05:00] Under pressure (RAM 92% full): moving more of each model to the CPU, GPU share 80% → 70%. llama-swap restarts once no model is answering.',
      '[2026-10-15 10:06:00] Restarted llama-swap with 70% of each model on the GPU.',
      '[2026-10-15 11:00:00] Auto-tune: Kept 90% on the GPU for qwen (31.0 tokens/s).',
    ].join('\n')
    expect(parseShareChanges(log).map(c => [c.share, c.why])).toEqual([[70, 'Eased off the GPU (computer under pressure)'], [90, 'Auto-tune']])
  })
})
