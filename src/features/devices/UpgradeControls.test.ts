import { describe, expect, it } from 'vitest'
import { compareVersions } from './UpgradeControls'

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('0.8.0', '0.8.1')).toBe(-1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.8', '0.8.0')).toBe(0)
  })
  it('treats an unknown version as older', () => {
    expect(compareVersions(undefined, '0.8.0')).toBe(-1)
  })
})
