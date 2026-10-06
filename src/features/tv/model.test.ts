import { describe, expect, it } from 'vitest'
import { addWatched, SERVICES, serviceFor, shortcutName, shortcutUrl, WATCHED_MAX } from './model'
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

describe('continue watching', () => {
  it('keeps the latest page per service, newest first', () => {
    let list = addWatched([], { url: 'https://www.netflix.com/watch/1', title: 'Ep 1', at: 1 })
    list = addWatched(list, { url: 'https://tubitv.com/movies/2', title: 'Film', at: 2 })
    list = addWatched(list, { url: 'https://www.netflix.com/watch/3', title: 'Ep 3', at: 3 })
    expect(list.map(w => w.title)).toEqual(['Ep 3', 'Film'])
    expect(addWatched(list, { url: 'about:blank', title: '', at: 4 })).toBe(list)
    for (let i = 0; i < 10; i++) list = addWatched(list, { url: `https://site${i}.com/`, title: '', at: 10 + i })
    expect(list).toHaveLength(WATCHED_MAX)
    expect(serviceFor('https://www.netflix.com/watch/3').name).toBe('Netflix')
    expect(serviceFor('https://nebula.tv/videos/x', [{ name: 'Nebula', url: 'https://nebula.tv/' }]).name).toBe('Nebula')
    expect(serviceFor('https://www.example.org/x').name).toBe('Example')
  })
})
