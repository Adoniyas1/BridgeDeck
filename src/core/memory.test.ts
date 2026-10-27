import { describe, expect, it } from 'vitest'
import { idleToUnload } from './memory'

describe('unloading idle tabs', () => {
  it('picks tabs hidden long enough, never the ones on screen', () => {
    const since = { notes: 0, study: 50_000, home: 0 }
    expect(idleToUnload(['notes', 'study', 'home', 'files'], ['home', null], since, 60_000, 30_000)).toEqual(['notes'])
    // "Unload now": every hidden one, however recent.
    expect(idleToUnload(['notes', 'study', 'home', 'files'], ['home', null], since, 60_000, 0)).toEqual(['notes', 'study', 'files'])
  })
})
