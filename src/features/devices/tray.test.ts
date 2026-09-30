import { describe, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
import { trayPeers } from './tray'

describe('tray menu', () => {
  it('offers Control for Macs and PCs, and Send files where LocalSend is known', () => {
    const peers = trayPeers(
      [{ instanceId: 'mac', name: 'Mac', platform: 'macos' }, { instanceId: 'pi', name: 'Pi', platform: 'linux' }],
      [{ id: 'mac', localsendTarget: '10.0.0.2:53317' }, { id: 'pi', localsendTarget: '' }],
    )
    expect(peers).toEqual([
      { id: 'mac', name: 'Mac', canControl: true, canReceive: true },
      { id: 'pi', name: 'Pi', canControl: false, canReceive: false },
    ])
  })
})
