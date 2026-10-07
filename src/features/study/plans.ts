/** Degree plans: the recommended courses by semester, from a department's flowchart. Each course
 *  can be marked done or being taken, and a slot (an elective, a GE area) can be given the course
 *  chosen for it. The state is kept beside the courses (`.degree-plan.json`), so it syncs. */

export type PlanCourse = {
  /** Stable within the plan. */
  id: string
  /** Catalog code, or empty for a slot to fill ("Sequence Elective", a GE area). */
  code: string
  title: string
  units: number
  /** Another course that does instead ("PHYS 152 or EE 210+210L"). */
  or?: string
  pre?: string
  note?: string
}
export type Plan = { id: string; name: string; school: string; total: number; semesters: PlanCourse[][]; notes: string[] }

export type CourseStatus = 'done' | 'taking'
export type PlanState = { plan: string; status: Record<string, CourseStatus>; chosen: Record<string, string> }

const c = (id: string, code: string, title: string, units: number, extra: Partial<PlanCourse> = {}): PlanCourse => ({ id, code, title, units, ...extra })

/** CSULB Electrical Engineering, AY 2025–2026 (unofficial flowchart, rev. 7/28/2025). */
const CSULB_EE: Plan = {
  id: 'csulb-ee-2025-26',
  name: 'Electrical Engineering (BSEE)',
  school: 'CSULB · 2025–2026 flowchart',
  total: 120,
  semesters: [
    [
      c('math122', 'MATH 122', 'Calculus I', 4, { pre: 'MATH 111, 112B/113', note: 'GE 2/B4. Must pass within the first year.' }),
      c('phys151', 'PHYS 151', 'Mechanics and Heat', 4, { note: 'GE 5A/B1 & 5C/B3. Co: MATH 122/123/224' }),
      c('ee186', 'EE 186', 'Intro. to Programming and Applications', 3, { note: 'Co: GE 1A/A2' }),
      c('engr101', 'ENGR 101', 'Intro. to Engineering', 1, { note: 'Co: MATH 111/113/122+' }),
      c('ge1a', '', 'GE 1A/A2 · English Composition', 3, { note: 'Foundation' }),
    ],
    [
      c('math123', 'MATH 123', 'Calculus II', 4, { pre: 'MATH 122' }),
      c('phys152', 'PHYS 152', 'Electricity and Magnetism', 4, { or: 'EE 210+210L', pre: 'PHYS 151, Co: MATH 123' }),
      c('ee201', 'EE 201', 'Digital Logic Design', 3),
      c('engr102', 'ENGR 102', 'Academic Success Skills', 1, { pre: 'ENGR 101' }),
      c('ee200', 'EE 200', 'Trends in Electrical Engineering', 1),
      c('ge1c', '', 'GE 1C/A1 · Oral Communication', 3, { note: 'Foundation' }),
    ],
    [
      c('math370a', 'MATH 370A', 'Applied Mathematics I', 3, { pre: 'MATH 123' }),
      c('ee202', 'EE 202', 'Comp. Methods in Engineering', 3, { pre: 'EE 186, MATH 123' }),
      c('ee301', 'EE 301', 'Digital System Design', 3, { pre: 'EE 201' }),
      c('ee211', 'EE 211', 'Electric and Electronic Circuits (+ EE 211L)', 4, { pre: 'MATH 123, PHYS 152/EE 210+L' }),
      c('ge3a', '', 'GE 3A/C1 · Arts', 3),
    ],
    [
      c('math224', 'MATH 224', 'Calculus 3', 4, { pre: 'MATH 123' }),
      c('phys254', 'PHYS 254', 'Applied Modern Physics', 3, { or: 'EE 220 (Material Sci.)', pre: 'EE 210/PHYS 152, Co: MATH 224' }),
      c('ee346', 'EE 346', 'Microprocessor Principles and Applications', 3, { pre: 'EE 201, 202' }),
      c('ee310', 'EE 310', 'Signals and Systems', 3, { pre: 'EE 211, MATH 370A; Co: EE 202' }),
      c('ge3b', '', 'GE 3B/C2 · Humanities', 3),
    ],
    [
      c('ee360', 'EE 360', 'Electromagnetic Fields', 3, { pre: 'MATH 224, EE 310' }),
      c('ee330', 'EE 330', 'Analog Electronic Circuits I', 4, { pre: 'EE 211, 211L' }),
      c('ee370', 'EE 370', 'Control Systems (+ EE 370L)', 4, { pre: 'EE 202, 310' }),
      c('ee386', 'EE 386', 'Digital Signal Processing', 3, { pre: 'EE 310/CECS 301' }),
    ],
    [
      c('ee350', 'EE 350', 'Energy Conversion Principles', 3, { pre: 'EE 202, 211, 211L', note: 'Prereq for the Power electives' }),
      c('ee380', 'EE 380', 'Probability, Stats, Stochastic Models', 3, { pre: 'GE Foundations, 60u+, MATH 123, EE 202', note: 'GE 2/5UD (UD B)' }),
      c('ee430', 'EE 430', 'Analog Electronic Circuits II (+ EE 430L)', 4, { pre: 'EE 330' }),
      c('ee382', 'EE 382', 'Communication Systems I', 3, { pre: 'EE 202, 310' }),
    ],
    [
      c('ee400d', 'EE 400D', 'Electrical Engr. Design Project', 3, { pre: 'EE 301/346, 330, 350, 370, 382/386' }),
      c('elec1', '', 'Sequence Elective', 3, { note: 'From your emphasis (see below)' }),
      c('elec2', '', 'Sequence Elective', 3, { note: 'From your emphasis (see below)' }),
      c('hist', 'HIST 172', 'Early U.S. History', 3, { or: 'HIST 173 (Recent U.S. History)', note: 'GE 4A/D1' }),
      c('posc100', 'POSC 100', 'U.S. Constitution & American Ideals', 3, { note: 'GE 4B/D2' }),
    ],
    [
      c('capstone', '', 'Capstone', 3, { note: 'EE 471, EE 488/489, EE 447 or EE 458' }),
      c('elec3', '', 'Sequence Elective', 3, { note: 'From your emphasis (see below)' }),
      c('ge3ud', '', 'GE 3UD · Upper Division Arts or Humanities', 3, { note: 'Writing Intensive option' }),
      c('ge4ud', '', 'GE 4UD · Upper Division Social Sciences', 3, { note: 'Writing Intensive option' }),
      c('ge6', '', 'GE 6/F · Ethnic Studies', 3),
    ],
  ],
  notes: [
    'Electives: 9 units from one emphasis, including its starred capstone. Control: EE 471*, 412, 442, 482, 486. Digital signal processing, communications & machine learning: EE 488* or 489*, 427, 482, 483, 486. Electronics: EE 447*, 434, 435, 436, 442, 444. Power: EE 458*, 450, 451, 452, 453.',
    'Plus 3 units from: EE 405, 406/L, 407, 412, 420, 427, 428, 434, 435, 436, 442, 444, 448, 450–453, 462, 470, 474, 476, 481–483, 486, 490, 495.',
    'To fully declare in COE: MATH 122, 123, EE 186, PHYS 151, GE 1A and 1C with ≥ 2.5 GPA before 60 units; then keep ≥ 2.0.',
    'Unofficial and subject to change: check your Academic Requirements Report.',
  ],
}

export const PLANS: Plan[] = [CSULB_EE]

export const emptyPlanState = (plan = PLANS[0].id): PlanState => ({ plan, status: {}, chosen: {} })

export function readPlanState(text: string): PlanState {
  try {
    const raw = JSON.parse(text) as Partial<PlanState>
    const plan = PLANS.some(p => p.id === raw.plan) ? raw.plan! : PLANS[0].id
    const status: Record<string, CourseStatus> = {}
    for (const [id, s] of Object.entries(raw.status ?? {})) if (s === 'done' || s === 'taking') status[id] = s
    const chosen: Record<string, string> = {}
    for (const [id, v] of Object.entries(raw.chosen ?? {})) if (typeof v === 'string' && v.trim()) chosen[id] = v.trim().slice(0, 60)
    return { plan, status, chosen }
  } catch { return emptyPlanState() }
}

/** A course's code as planned: its own, or the one chosen for a slot. */
export const plannedCode = (course: PlanCourse, state: PlanState) => course.code || state.chosen[course.id] || ''

export function planTotals(plan: Plan, state: PlanState) {
  const all = plan.semesters.flat()
  const units = (s: CourseStatus) => all.filter(x => state.status[x.id] === s).reduce((sum, x) => sum + x.units, 0)
  return { done: units('done'), taking: units('taking'), total: plan.total }
}

/** The plan's title for a course code ("MATH 224" → "Calculus 3"), for courses named by code. */
export function catalogTitle(code: string, plans = PLANS): string {
  for (const plan of plans) for (const course of plan.semesters.flat()) if (course.code && course.code === code) return course.title.replace(/\s*\(\+.*\)$/, '')
  return ''
}

/** Whether a course named by hand ("Calc 3", "Digital logic") is a catalog course ("Calculus 3",
 *  "Digital Logic Design"): each word of the name starts a word of the title, in order, numbers equal. */
export function sameCourseTitle(name: string, title: string) {
  const words = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9]+/).filter(w => w && !['and', 'of', 'to', 'the', 'intro'].includes(w))
  const [a, b] = [words(name), words(title)]
  if (!a.length || !b.length || a.length > b.length) return false
  let j = 0
  for (const w of a) {
    while (j < b.length && !(/^\d/.test(w) ? b[j] === w : w.length >= 3 && b[j].startsWith(w))) j++
    if (j++ >= b.length) return false
  }
  return true
}
