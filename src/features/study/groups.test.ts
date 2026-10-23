import { describe, expect, it } from 'vitest'
import { clockText, freeSlots, parseBusy } from './groups'

describe('study groups', () => {
  it('reads typed class times', () => {
    expect(parseBusy('MW 10:00-11:15, TuTh 2-3:15pm; F 9-12; whenever')).toEqual([
      { days: [1, 3], start: 600, end: 675 }, { days: [2, 4], start: 840, end: 915 }, { days: [5], start: 540, end: 720 },
    ])
  })
  it('finds when everyone is free', () => {
    const slots = freeSlots([{ days: [1], start: 600, end: 675 }, { days: [1], start: 660, end: 780 }, { days: [2, 3, 4, 5], start: 480, end: 1200 }], 480, 1200, 60)
    expect(slots.map(s => `${s.day} ${clockText(s.start)}-${clockText(s.end)}`)).toEqual(['1 8am-10am', '1 1pm-8pm'])
  })
})
