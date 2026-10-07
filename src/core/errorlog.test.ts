import { describe, expect, it, vi } from 'vitest'

const sent: Array<[string, string]> = []
vi.mock('../lib/bridge', () => ({ isTauri: () => true, errorLogAdd: async (source: string, message: string) => { sent.push([source, message]) } }))

describe('error log from the window', () => {
  it('keeps the same message once a minute and caps the rate', async () => {
    const { logError } = await import('./errorlog')
    logError('window', 'boom', 1_000)
    logError('window', 'boom', 2_000)
    logError('window', 'boom', 70_000)
    expect(sent.map(s => s[1])).toEqual(['boom', 'boom'])
    for (let i = 0; i < 50; i++) logError('window', `err ${i}`, 80_000)
    expect(sent.length).toBe(2 + 29)
  })
})
