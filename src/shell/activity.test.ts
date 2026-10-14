import { describe, expect, it } from 'vitest'
import { describeCommand } from '../core/activity'
import { filterLog } from './ActivitySettings'

const LOG = `[2026-10-13 23:50:01] INFO  app: BridgeDeck 0.9.1 started on macOS 15.
[2026-10-13 23:50:02] INFO  command: circuit_save (12 ms)
[2026-10-13 23:51:00] WARN  safety: Safety stop: memory ran low
    stopped 2 programs
[2026-10-13 23:52:00] ERROR window: TypeError: x is undefined
[2026-10-13 23:53:00] CRASH crash: panic in thread main
`

describe('activity log', () => {
  it('filters to problems or crashes, keeping continuation lines with their entry', () => {
    expect(filterLog(LOG, 'all', '')).toHaveLength(5)
    expect(filterLog(LOG, 'problems', '').map(e => e.split(' ')[2])).toEqual(['WARN', 'ERROR', 'CRASH'])
    expect(filterLog(LOG, 'problems', '')[0]).toContain('\n    stopped 2 programs')
    expect(filterLog(LOG, 'crashes', '')).toHaveLength(1)
    expect(filterLog(LOG, 'all', 'CIRCUIT')).toHaveLength(1)
    expect(filterLog('', 'all', '')).toEqual([])
  })

  it('logs actions, failures and slow commands, but not reads and polls', () => {
    expect(describeCommand('circuit_save', 12)).toEqual({ kind: 'info', message: 'circuit_save (12 ms)' })
    expect(describeCommand('code_run', 2400)).toEqual({ kind: 'info', message: 'code_run (2.4 s)' })
    expect(describeCommand('bridgelink_status', 30)).toBeNull()
    expect(describeCommand('bridgelink_status', 30, 'timed out')).toEqual({ kind: 'warn', message: 'bridgelink_status failed after 30 ms: timed out' })
    expect(describeCommand('notes_list', 6200)?.message).toBe('notes_list took 6.2 s')
    expect(describeCommand('activity_add', 10)).toBeNull()
    expect(describeCommand('bridgelink_poll_pair', 3)).toBeNull()
    expect(describeCommand('localsend_receiver_status', 2)).toBeNull()
    expect(describeCommand('vault_settings', 5)).toBeNull()
    expect(describeCommand('localsend_send_native', 40)?.message).toBe('localsend_send_native (40 ms)')
  })
})
