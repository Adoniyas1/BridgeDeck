import { describe, expect, it } from 'vitest'
import { parseQuickAdd } from './quickAdd'
import { guessHours } from './planner'

const ee = { name: 'EE 310', info: { code: 'EE 310', meetings: [{ days: [2, 4], start: '10:00', end: '11:15', room: '', kind: 'Lecture' }, { days: [5], start: '13:00', end: '15:45', room: '', kind: 'Lab' }] } }
const math = { name: 'Calc 3', info: { code: 'MATH 224', meetings: [] } }
const mon = new Date(2026, 9, 19, 9, 0).getTime() // Monday 9:00

describe('quick add in plain words', () => {
  it('finds the course, the due date and the hours', () => {
    const a = parseQuickAdd('EE 310 HW 5 due next class ~3h', [ee, math], null, mon)
    expect(a.course).toBe('EE 310')
    expect(a.title).toBe('HW 5 (~3h)')
    expect(new Date(a.due!)).toEqual(new Date(2026, 9, 20, 10, 0))
    expect(guessHours('assignment', a.title)).toBe(3)
  })
  it('knows the next lab, weekdays, dates and times', () => {
    expect(new Date(parseQuickAdd('ee310: prelab 4 due next lab', [ee], null, mon).due!)).toEqual(new Date(2026, 9, 23, 13, 0))
    expect(new Date(parseQuickAdd('MATH 224 quiz due fri 5pm', [ee, math], null, mon).due!)).toEqual(new Date(2026, 9, 23, 17, 0))
    expect(parseQuickAdd('MATH 224 quiz due fri 5pm', [ee, math], null, mon).course).toBe('Calc 3')
    expect(new Date(parseQuickAdd('essay due 10/31', [], null, mon).due!)).toEqual(new Date(2026, 9, 31, 23, 59))
    expect(new Date(parseQuickAdd('read ch 4 due tomorrow', [], null, mon).due!)).toEqual(new Date(2026, 9, 20, 23, 59))
    expect(new Date(parseQuickAdd('lab report due Nov 3 at 17:00', [], null, mon).due!)).toEqual(new Date(2026, 10, 3, 17, 0))
  })
  it('leaves what it can’t read in the title, and uses the course it was added in', () => {
    const a = parseQuickAdd('Problem set 4', [ee], null, mon, 'EE 310')
    expect(a).toMatchObject({ course: 'EE 310', title: 'Problem set 4', due: null })
  })
})
