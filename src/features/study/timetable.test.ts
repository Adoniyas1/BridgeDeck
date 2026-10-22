import { describe, expect, it } from 'vitest'
import { clashes, meetingOf, readDays, readSchedule, readTimes } from './timetable'

const PASTED = `EE 381  PROBABILITY AND STATISTICS (3 Units)
SEC.  CLASS #  NO COST  RESERVE  CLASS NOTES  TYPE  DAYS  TIME  OPEN SEATS  LOCATION  INSTRUCTOR
01  6014    SEM  MW  11-12:15PM    ECS-302  Smith J
02  6015    SEM  TuTh  2-3:15PM    VEC-115  Lee K
EE 382  SIGNALS AND SYSTEMS
01  6020    LEC  MW  11:30-12:45PM    EN2-200  Park S
02  6021    LAB  F  8-10:45AM    ECS-405  Staff
03  6022    LEC  TBA  TBA    ONLINE-ONLY  Staff`

describe('class schedule', () => {
  it('reads days and times', () => {
    expect(readDays('TuTh')).toEqual([2, 4])
    expect(readDays('MWF')).toEqual([1, 3, 5])
    expect(readDays('TBA')).toBeNull()
    expect(readTimes('11-12:15PM')).toEqual(['11:00', '12:15'])
    expect(readTimes('2-4:45PM')).toEqual(['14:00', '16:45'])
    expect(readTimes('7:30-8:45AM')).toEqual(['07:30', '08:45'])
    expect(readTimes('11AM-1PM')).toEqual(['11:00', '13:00'])
  })
  it('reads sections and finds clashes', () => {
    const sections = readSchedule(PASTED)
    expect(sections.map(s => `${s.course} ${s.section} ${s.kind} ${s.days.join('')} ${s.start}-${s.end} ${s.room}`)).toEqual([
      'EE 381 01 SEM 13 11:00-12:15 ECS-302', 'EE 381 02 SEM 24 14:00-15:15 VEC-115', 'EE 382 01 LEC 13 11:30-12:45 EN2-200', 'EE 382 02 LAB 5 08:00-10:45 ECS-405',
    ])
    expect(sections[0].title).toBe('PROBABILITY AND STATISTICS')
    expect(clashes([sections[0], sections[2]])).toHaveLength(1)
    expect(clashes([sections[1], sections[2], sections[3]])).toHaveLength(0)
    expect(meetingOf(sections[3])).toEqual({ days: [5], start: '08:00', end: '10:45', room: 'ECS 405', kind: 'lab' })
  })
})
