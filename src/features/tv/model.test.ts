import { describe, expect, it } from 'vitest'
import { SERVICES, shortcutName, shortcutUrl } from './model'
import { cleanShortcuts } from '../../lib/config'

describe('TV', () => {
  it('turns typed addresses into web addresses', () => {
    expect(shortcutUrl('nebula.tv')).toBe('https://nebula.tv/')
    expect(shortcutUrl('https://www.criterionchannel.com/browse')).toBe('https://www.criterionchannel.com/browse')
    expect(shortcutUrl('not a site')).toBeNull()
    expect(shortcutUrl('localhost')).toBeNull()
    expect(shortcutUrl('')).toBeNull()
  })
  it('names a shortcut after its site', () => {
    expect(shortcutName('https://www.criterionchannel.com/browse')).toBe('Criterionchannel')
    expect(shortcutName('https://nebula.tv/')).toBe('Nebula')
  })
  it('keeps only named web shortcuts in settings', () => {
    expect(cleanShortcuts([{ name: 'Nebula', url: 'https://nebula.tv/' }, { name: 'x', url: 'file:///etc/passwd' }, { name: '', url: 'https://a.b/' }, 'junk']))
      .toEqual([{ name: 'Nebula', url: 'https://nebula.tv/' }])
  })
  it('only offers web addresses', () => {
    expect(SERVICES.every(s => s.url.startsWith('https://'))).toBe(true)
  })
})
