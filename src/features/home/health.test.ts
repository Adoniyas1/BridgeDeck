import { describe, expect, it } from 'vitest'
import { healthIssues, type HealthInput } from './health'

const healthy: HealthInput = {
  pairingRunning: true, pairedCount: 1, mac: true, messages: { ready: true, detail: '' },
  permissions: { screenRecording: true, accessibility: true }, remoteAllowed: true,
  sync: { builtin: true, available: true, running: true }, receiver: { enabled: true, running: true },
  clipboard: { on: true, available: true }, conflicts: 0, settled: true,
}

describe('health', () => {
  it('has nothing to say when everything works', () => {
    expect(healthIssues(healthy)).toEqual([])
  })

  it('points at the right Mac permission', () => {
    const issues = healthIssues({ ...healthy, messages: { ready: false, detail: 'Give Full Disk Access to BridgeDeck' }, permissions: { screenRecording: false, accessibility: false } })
    expect(issues.map(i => i.fix?.action)).toEqual(['files-access', 'screen-recording', 'accessibility'])
  })

  it('skips remote permissions when remote control is off, and start-up states until settled', () => {
    expect(healthIssues({ ...healthy, remoteAllowed: false, permissions: { screenRecording: false, accessibility: false } })).toEqual([])
    const starting = { ...healthy, settled: false, pairingRunning: false, sync: { ...healthy.sync, running: false }, receiver: { enabled: true, running: false } }
    expect(healthIssues(starting)).toEqual([])
    expect(healthIssues({ ...starting, settled: true }).map(i => i.id)).toEqual(['pairing', 'sync', 'receiver'])
  })

  it('counts conflicts', () => {
    expect(healthIssues({ ...healthy, conflicts: 2 })[0]).toMatchObject({ title: '2 sync conflicts', fix: { action: 'open-sync' } })
  })
})
