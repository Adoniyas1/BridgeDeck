import { describe, expect, it } from 'vitest'
import { registerTabContext, workContext } from './tabContext'
import { activateTab } from './tabs'

describe('workContext', () => {
  it('describes the last tab worked in that has something to show, skipping Mimir', () => {
    let logic: string | null = 'a circuit'
    const offLogic = registerTabContext('logic', () => (logic ? { title: 'logic', text: logic } : null))
    const offCode = registerTabContext('code', () => ({ title: 'code', text: 'a program' }))
    activateTab('logic'); activateTab('code'); activateTab('mimir')
    expect(workContext()).toEqual({ title: 'code', text: 'a program' })
    activateTab('logic'); activateTab('mimir')
    expect(workContext()?.title).toBe('logic')
    logic = null
    expect(workContext()?.title).toBe('code') // logic has nothing now, so the one before it
    offLogic(); offCode()
    expect(workContext()).toBeNull()
  })
})
