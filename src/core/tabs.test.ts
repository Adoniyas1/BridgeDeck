import { describe, expect, it } from 'vitest'
import { activateIn, closeIn, closeOthersIn, closeRightIn, initialTabs, moveIn, openIn, openOf, reopenIn, replaceIn, restored, saveable, splitIn, unsplitIn, type TabsState } from './tabs'

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

  it('closes app pages like any tab, and keeps Home when the last one closes', () => {
    let state = activateIn(initialTabs, 'files')
    expect(openOf(state)).toEqual(['home', 'files'])
    state = closeIn(state, 'files')
    expect([state.active, openOf(state)]).toEqual(['home', ['home']])
    state = closeIn(state, 'home')
    expect([state.active, openOf(state)]).toEqual(['home', ['home']])
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

  it('opens a tab next to the one showing, and shows a neighbour when the active one closes', () => {
    let state = activateIn(activateIn(initialTabs, 'notes'), 'calendar')
    state = activateIn(state, 'notes')
    state = activateIn(state, 'study')
    expect(openOf(state)).toEqual(['home', 'notes', 'study', 'calendar'])
    // History first: the tab used before.
    expect(closeIn(state, 'study').active).toBe('notes')
    // Without history, the neighbour where it was.
    expect(closeIn({ ...state, history: ['study'] }, 'study').active).toBe('calendar')
  })

  it('reorders, closes others or those to the right, and opens closed tabs again', () => {
    let state = ['notes', 'calendar', 'study'].reduce(activateIn, initialTabs)
    state = openIn(state, { id: 'web:x', kind: 'web', title: 'X', params: { page: 'web-x', url: 'https://x.org' } })
    expect(openOf(moveIn(state, 'web:x', 0))).toEqual(['web:x', 'home', 'notes', 'calendar', 'study'])
    expect(moveIn(state, 'home', 0)).toBe(state)
    expect(openOf(closeOthersIn(state, 'calendar', ['home']))).toEqual(['home', 'calendar'])
    expect(openOf(closeRightIn(state, 'notes'))).toEqual(['home', 'notes'])
    state = closeIn(closeIn(state, 'notes'), 'web:x')
    state = reopenIn(state)
    expect(state.active).toBe('web:x')
    expect(state.dynamic.find(t => t.id === 'web:x')?.params?.url).toBe('https://x.org')
    state = reopenIn(state)
    expect(state.active).toBe('notes')
    expect(reopenIn(state)).toEqual(state)
  })

  it('turns a new tab into the app or page picked in it', () => {
    let state = openIn(activateIn(initialTabs, 'notes'), { id: 'newtab:1', kind: 'newtab', title: 'New tab' })
    state = replaceIn(state, 'newtab:1', 'calendar')
    expect([state.active, openOf(state), state.dynamic]).toEqual(['calendar', ['home', 'notes', 'calendar'], []])
    // An app already open: the new tab goes, and that tab shows.
    state = openIn(state, { id: 'newtab:2', kind: 'newtab', title: 'New tab' })
    state = replaceIn(state, 'newtab:2', 'notes')
    expect([state.active, openOf(state)]).toEqual(['notes', ['home', 'notes', 'calendar']])
    // A web page takes the new tab's place; closing an unused new tab isn't remembered.
    state = openIn(activateIn(state, 'home'), { id: 'newtab:3', kind: 'newtab', title: 'New tab' })
    state = replaceIn(state, 'newtab:3', { id: 'web:y', kind: 'web', title: 'Y' })
    expect(openOf(state)).toEqual(['home', 'web:y', 'notes', 'calendar'])
    const closed = closeIn(openIn(state, { id: 'newtab:4', kind: 'newtab', title: 'New tab' }), 'newtab:4')
    expect(closed.closed).toEqual(state.closed)
  })

  it('keeps the tabs between runs, but not ones that belong to the run', () => {
    let state = activateIn(initialTabs, 'notes')
    state = openIn(state, { id: 'web:x', kind: 'web', title: 'X', params: { page: 'web-x', url: 'https://x.org' } })
    state = openIn(state, session('remote:mac'))
    const saved = JSON.parse(JSON.stringify(saveable(state)))
    expect(saved.open).toEqual(['home', 'notes', 'web:x'])
    expect(saved.active).toBe('home')
    const back = restored(saved, id => ['home', 'notes'].includes(id))
    expect([back.active, openOf(back), back.dynamic.map(t => t.id)]).toEqual(['home', ['home', 'notes', 'web:x'], ['web:x']])
    // Pages that no longer exist are left out; nothing valid means a fresh start.
    expect(openOf(restored({ open: ['gone', 'notes'], active: 'gone', dynamic: [] }, id => id === 'notes'))).toEqual(['notes'])
    expect(restored('nonsense', () => true)).toBe(initialTabs)
  })
})
