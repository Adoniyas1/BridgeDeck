import { describe, expect, it } from 'vitest'
import { activateIn, closeIn, initialTabs, openIn, splitIn, unsplitIn, type TabsState } from './tabs'

const session = (id: string, title = id) => ({ id, kind: 'remote-session', title })

describe('tabs', () => {
  it('opens a dynamic tab and makes it active', () => {
    const state = openIn(initialTabs, session('remote:mac'))
    expect(state.active).toBe('remote:mac')
    expect(state.dynamic.map(tab => tab.id)).toEqual(['remote:mac'])
  })

  it('reuses a tab with the same id instead of duplicating it', () => {
    let state = openIn(initialTabs, session('remote:mac', 'Mac'))
    state = activateIn(state, 'files')
    state = openIn(state, session('remote:mac', 'Mac (reconnected)'))
    expect(state.dynamic).toHaveLength(1)
    expect(state.dynamic[0].title).toBe('Mac (reconnected)')
    expect(state.active).toBe('remote:mac')
  })

  it('returns to the previously active tab when the active tab closes', () => {
    let state: TabsState = activateIn(initialTabs, 'files')
    state = openIn(state, session('a'))
    state = openIn(state, session('b'))
    state = closeIn(state, 'b')
    expect(state.active).toBe('a')
    state = closeIn(state, 'a')
    expect(state.active).toBe('files')
  })

  it('keeps the active tab when a background tab closes', () => {
    let state = openIn(initialTabs, session('a'))
    state = openIn(state, session('b'))
    state = closeIn(state, 'a')
    expect(state.active).toBe('b')
    expect(state.dynamic.map(tab => tab.id)).toEqual(['b'])
  })

  it('never closes fixed tabs', () => {
    const state = activateIn(initialTabs, 'files')
    expect(closeIn(state, 'files')).toBe(state)
  })

  it('falls back to Home when history is empty', () => {
    const state = closeIn({ active: 'x', dynamic: [session('x')], history: ['x'] }, 'x')
    expect(state.active).toBe('home')
  })
  it('shows a second tab beside the active one, and swaps or ends the split', () => {
    let state = openIn(initialTabs, session('book:a'))
    state = openIn(state, session('book:b'))
    // Splitting the active tab puts the one used before it on the left.
    state = splitIn(state, 'book:b')
    expect([state.active, state.split]).toEqual(['book:a', 'book:b'])
    // Picking the right one swaps the sides.
    state = activateIn(state, 'book:b')
    expect([state.active, state.split]).toEqual(['book:b', 'book:a'])
    // Another tab takes the left; the right stays.
    state = activateIn(state, 'notes')
    expect([state.active, state.split]).toEqual(['notes', 'book:a'])
    // Closing the right side ends the split.
    expect(closeIn(state, 'book:a').split).toBeNull()
    // Closing the left: the split ends too, rather than one tab on both sides.
    state = splitIn(openIn(state, session('book:c')), 'book:b')
    expect([state.active, state.split]).toEqual(['book:c', 'book:b'])
    const closed = closeIn(state, 'book:c')
    expect(closed.split).toBeNull()
    expect(unsplitIn(state).split).toBeNull()
    // Splitting home when nothing else was open does nothing.
    expect(splitIn(initialTabs, 'home')).toBe(initialTabs)
  })
})
