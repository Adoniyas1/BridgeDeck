import { describe, expect, it } from 'vitest'
import { catalogTitle, PLANS, planTotals, readPlanState, sameCourseTitle } from './plans'

describe('degree plans', () => {
  it('has the flowchart’s units in each semester', () => {
    const plan = PLANS[0]
    expect(plan.semesters.map(s => s.reduce((sum, c) => sum + c.units, 0))).toEqual([15, 16, 16, 16, 14, 13, 15, 15])
    expect(planTotals(plan, readPlanState('{"status":{"math122":"done","math224":"taking"}}'))).toEqual({ done: 4, taking: 4, total: 120 })
    expect(catalogTitle('MATH 224')).toBe('Calculus 3')
    expect(catalogTitle('EE 370')).toBe('Control Systems')
  })
  it('matches courses named by hand to catalog titles', () => {
    expect(sameCourseTitle('Calc 3', 'Calculus 3')).toBe(true)
    expect(sameCourseTitle('Calc 3', 'Calculus II')).toBe(false)
    expect(sameCourseTitle('Digital logic', 'Digital Logic Design')).toBe(true)
    expect(sameCourseTitle('Signals', 'Signals and Systems')).toBe(true)
    expect(sameCourseTitle('EE 201', 'Digital Logic Design')).toBe(false)
  })
  it('reads saved state, ignoring junk', () => {
    expect(readPlanState('not json').status).toEqual({})
    expect(readPlanState('{"status":{"a":"done","b":"nope"},"chosen":{"elec1":" EE 482 "}}')).toEqual({ plan: PLANS[0].id, status: { a: 'done' }, chosen: { elec1: 'EE 482' } })
  })
})
