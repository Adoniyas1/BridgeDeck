import { describe, expect, it } from 'vitest'
import { catalogTitle, DECLARE_COURSES, eligibleNext, gpa, PLANS, planTotals, readPlanState, readPrereqs, sameCourseTitle } from './plans'

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
    expect(readPlanState('{"status":{"a":"done","b":"nope"},"chosen":{"elec1":" EE 482 "},"grades":{"a":"B","b":"Q"},"next":["x",3]}')).toEqual({ plan: PLANS[0].id, status: { a: 'done' }, chosen: { elec1: 'EE 482' }, grades: { a: 'B' }, next: ['x'] })
  })
})

describe('next semester and GPA', () => {
  it('reads prerequisite lines', () => {
    expect(readPrereqs('EE 301/346, 330, 350, 370, 382/386')).toEqual({ groups: [['EE 301', 'EE 346'], ['EE 330'], ['EE 350'], ['EE 370'], ['EE 382', 'EE 386']], minUnits: 0 })
    expect(readPrereqs('EE 211, MATH 370A; Co: EE 202').groups).toEqual([['EE 211'], ['MATH 370A']])
    expect(readPrereqs('GE Foundations, 60u+, MATH 123, EE 202')).toEqual({ groups: [['MATH 123'], ['EE 202']], minUnits: 60 })
    expect(readPrereqs('MATH 123, PHYS 152/EE 210+L').groups).toEqual([['MATH 123'], ['PHYS 152', 'EE 210']])
  })
  it('lists what can be taken next from what’s done and being taken', () => {
    const plan = PLANS[0]
    const state = readPlanState(JSON.stringify({ status: { math122: 'done', phys151: 'done', ee186: 'done', engr101: 'done', ge1a: 'done', math123: 'done', phys152: 'taking', ee201: 'taking' } }))
    const next = eligibleNext(plan, state)
    const ok = (id: string) => next.find(n => n.course.id === id)!.missing
    expect(ok('math224')).toEqual([])
    expect(ok('ee301')).toEqual([])
    expect(ok('ee202')).toEqual([])
    expect(ok('ee310')).toEqual(['EE 211', 'MATH 370A'])
    expect(ok('ee380')).toEqual(['EE 202', '60 units'])
  })
  it('works out the GPA and the declaring GPA', () => {
    const plan = PLANS[0]
    const state = readPlanState(JSON.stringify({ status: { math122: 'done', phys151: 'done', ee186: 'done', ee201: 'taking' }, grades: { math122: 'B', phys151: 'A', ee186: 'C', ee201: 'A' } }))
    expect(gpa(plan, state)!.gpa).toBeCloseTo((3 * 4 + 4 * 4 + 2 * 3) / 11)
    expect(gpa(plan, state, DECLARE_COURSES)!.units).toBe(11)
    expect(gpa(plan, readPlanState('{}'))).toBeNull()
  })
})
