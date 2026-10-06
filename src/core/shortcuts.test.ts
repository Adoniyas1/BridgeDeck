import { describe, expect, it } from 'vitest'
import { askPrompt, shortcutFor } from './shortcuts'

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })

describe('shortcuts', () => {
  it('reads ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(shortcutFor(key('k', { metaKey: true }), true)).toBe('search')
    expect(shortcutFor(key('k', { ctrlKey: true }), true)).toBeNull()
    expect(shortcutFor(key('K', { ctrlKey: true }), false)).toBe('search')
    expect(shortcutFor(key('A', { ctrlKey: true, shiftKey: true }), false)).toBe('ask')
    expect(shortcutFor(key('a', { ctrlKey: true }), false)).toBeNull()
    expect(shortcutFor(key('k', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(shortcutFor(key('k'), false)).toBeNull()
    expect(shortcutFor(key('/', { metaKey: true }), true)).toBe('shortcuts')
  })

  it('asks about a passage', () => {
    expect(askPrompt('  the chain\nrule ', 'https://x.org')).toBe('Explain this in plain words (it\'s from https://x.org), then give me one example:\n\n"the chain rule"')
  })
})
