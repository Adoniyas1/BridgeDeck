import { describe, expect, it } from 'vitest'
import { setupSteps, type SetupInput } from './setup'

const fresh: SetupInput = {
  pairingRunning: true, pairedCount: 0, mac: true, messages: { ready: false, detail: 'Give Full Disk Access to BridgeDeck' },
  permissions: { screenRecording: false, accessibility: true }, remoteAllowed: true,
  sync: { builtin: true, available: true, running: true }, receiver: { enabled: true, running: true },
  clipboard: { on: true, available: true }, conflicts: 0, update: { behind: 0, installing: false }, settled: true,
  mimirEnabled: false, notificationsReviewed: false,
}

describe('setup checklist', () => {
  it('lists what a new Mac still needs, each with its fix', () => {
    const steps = setupSteps(fresh)
    expect(steps.filter(s => !s.done).map(s => [s.id, s.fix?.action])).toEqual([
      ['pair', 'pair'], ['messages', 'files-access'], ['remote', 'screen-recording'], ['mimir', 'open-mimir'], ['notifications', 'review-notifications'],
    ])
  })

  it('has no Mac steps on Windows and is complete once everything is done', () => {
    const windows = setupSteps({ ...fresh, mac: false, pairedCount: 1, mimirEnabled: true, notificationsReviewed: true })
    expect(windows.map(s => s.id)).toEqual(['pair', 'sync', 'files', 'mimir', 'notifications'])
    expect(windows.every(s => s.done)).toBe(true)
  })

  it('offers to start pairing when discovery is off', () => {
    expect(setupSteps({ ...fresh, pairingRunning: false })[0].fix?.action).toBe('start-pairing')
  })
})
