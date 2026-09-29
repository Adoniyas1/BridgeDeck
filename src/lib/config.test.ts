import { describe, expect, it } from 'vitest'
import { mergeConfig } from './config'

// A v0.7 config as the Windows PC saved it: this computer in the `windows` slot, the Mac paired in the
// `mac` slot, and a Matrix section that no longer exists.
const v7 = {
  configVersion: 7,
  machines: [
    { id: 'mac', name: 'Mac', agentUrl: 'http://192.168.4.28:41416', agentToken: 'peer-token', rustdeskPeerId: '123456789', localsendTarget: '192.168.4.28:53317', localsendPin: '', sharedPath: '/Users/a/BridgeDeck Shared', bridgeInstanceId: 'mac-instance', syncthingDeviceId: 'MAC-SYNC' },
    { id: 'windows', name: 'Windows', agentUrl: 'http://127.0.0.1:41416', agentToken: '', rustdeskPeerId: '987654321', localsendTarget: '127.0.0.1:53317', localsendPin: '', sharedPath: '', bridgeInstanceId: 'win-instance', syncthingDeviceId: 'WIN-SYNC' },
  ],
  services: [{ id: 'matrix', name: 'Matrix', enabled: true, autoStart: false }, { id: 'syncthing', name: 'Syncthing', enabled: false, autoStart: false }],
  matrix: { homeserver: 'https://m.example', roomId: '!r', accessToken: 't' },
  syncthing: { apiKey: 'key' },
}

describe('config migration from v0.7', () => {
  const config = mergeConfig(v7 as never)

  it('turns paired slots into devices keyed by BridgeLink instance ID', () => {
    expect(config.configVersion).toBe(8)
    expect(config.devices.map(d => d.id)).toEqual(['mac-instance', 'win-instance'])
    const mac = config.devices.find(d => d.id === 'mac-instance')!
    expect(mac).toMatchObject({ name: 'Mac', platform: 'macos', local: false, agentToken: 'peer-token', rustdeskPeerId: '123456789', syncthingDeviceId: 'MAC-SYNC', sharedPath: '/Users/a/BridgeDeck Shared' })
  })

  it('marks the slot pointing at the local API as this computer', () => {
    expect(config.devices.find(d => d.id === 'win-instance')).toMatchObject({ platform: 'windows', local: true })
  })

  it('drops Matrix and keeps other settings', () => {
    expect(config).not.toHaveProperty('matrix')
    expect(config).not.toHaveProperty('machines')
    expect(config.services.map(s => s.id)).not.toContain('matrix')
    expect(config.services.find(s => s.id === 'syncthing')?.enabled).toBe(false)
    expect(config.syncthing.apiKey).toBe('key')
    expect(config.syncthing.sharedFolderId).toBe('bridgedeck-shared')
  })

  it('drops untouched default slots and keeps hand-configured ones', () => {
    const migrated = mergeConfig({ machines: [
      { id: 'mac', name: 'Mac', agentUrl: 'http://127.0.0.1:4141', agentToken: '', rustdeskPeerId: '', localsendTarget: '', localsendPin: '', sharedPath: '', bridgeInstanceId: '', syncthingDeviceId: '' },
      { id: 'windows', name: 'Office PC', agentUrl: 'http://127.0.0.1:4142', agentToken: '', rustdeskPeerId: '', localsendTarget: '192.168.1.9', localsendPin: '', sharedPath: '', bridgeInstanceId: '', syncthingDeviceId: '' },
    ] } as never)
    expect(migrated.devices).toHaveLength(1)
    expect(migrated.devices[0]).toMatchObject({ id: 'manual-windows', name: 'Office PC', platform: 'windows', local: false, localsendTarget: '192.168.1.9' })
  })

  it('loads a v8 config as saved', () => {
    const again = mergeConfig(JSON.parse(JSON.stringify(config)))
    expect(again.devices).toEqual(config.devices)
  })
})
