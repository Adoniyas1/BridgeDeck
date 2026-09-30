import { describe, expect, it } from 'vitest'
import type { AiAgent } from '../../types'
import { agentsByDevice, who } from './state'

const agent = (name: string, deviceId: string, deviceName: string, local = false): AiAgent => ({ name, status: '', deviceId, deviceName, lastSeen: 0, online: true, local })

describe('AI workspace', () => {
  it('groups agents by device, this computer first', () => {
    const groups = agentsByDevice({ agents: [agent('codex-win', 'w', 'Windows'), agent('claude-mac', 'm', 'Mac', true), agent('claude-win', 'w', 'Windows')], rooms: [], claims: [] })
    expect(groups.map(g => g.device)).toEqual(['This computer', 'Windows'])
    expect(groups[1].agents.map(a => a.name)).toEqual(['codex-win', 'claude-win'])
  })

  it('describes who a message is from and for', () => {
    const base = { id: '1', channel: 'c', author: 'claude-mac', body: 'b', direction: 'in' as const, peerInstanceId: 'p', peerName: 'Mac', createdAt: 1 }
    expect(who(base)).toBe('claude-mac · from Mac')
    expect(who({ ...base, direction: 'out', peerName: 'Mac, Laptop', to: ['codex-win'] })).toBe('claude-mac · this computer → Mac, Laptop · to codex-win')
  })
})
