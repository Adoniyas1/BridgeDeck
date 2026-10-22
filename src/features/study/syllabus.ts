/** What Mimir read from a syllabus (an inbox entry of kind 'syllabus'), and how it changes the
 *  course's settings when accepted: grade weights, people and office hours, and the AI policy are
 *  merged into what's there (nothing is removed); exams become calendar events. */

import type { CourseInfo } from '../../lib/bridge'
import { readGrading, type GradeCategory } from './grades'
import { peopleOf, type Person } from './CoursePeople'

export type SyllabusExam = { title: string; start: number; room?: string; covers?: string }
export type Syllabus = { weights: Array<{ name: string; weight: number }>; people: Person[]; aiPolicy: 'none' | 'hints' | 'full' | null; exams: SyllabusExam[] }

const text = (v: unknown, n: number) => typeof v === 'string' ? v.trim().slice(0, n) : ''

export function readSyllabus(payload: Record<string, unknown>): Syllabus {
  const list = (v: unknown) => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') as Array<Record<string, unknown>> : []
  return {
    weights: list(payload.weights).map(w => ({ name: text(w.name, 40), weight: Number(w.weight) })).filter(w => w.name && Number.isFinite(w.weight) && w.weight >= 0 && w.weight <= 100).slice(0, 20),
    people: peopleOf({ people: payload.people }),
    aiPolicy: payload.aiPolicy === 'none' || payload.aiPolicy === 'hints' || payload.aiPolicy === 'full' ? payload.aiPolicy : null,
    exams: list(payload.exams).flatMap(e => typeof e.start === 'number' && Number.isFinite(e.start) ? [{ title: text(e.title, 80) || 'Exam', start: e.start, room: text(e.room, 60) || undefined, covers: text(e.covers, 200) || undefined }] : []).slice(0, 10),
  }
}

/** The course-setting changes (a patch for studyPatchCourseInfo) and, in words, what they change. */
export function applySyllabus(info: CourseInfo, s: Syllabus): { patch: Record<string, unknown>; changes: string[] } {
  const patch: Record<string, unknown> = {}
  const changes: string[] = []
  if (s.weights.length) {
    const grading = readGrading(info.grading)
    const categories: GradeCategory[] = grading.categories.map(c => ({ ...c }))
    for (const w of s.weights) {
      const same = categories.find(c => c.name.toLowerCase() === w.name.toLowerCase())
      if (same && same.weight !== w.weight) { changes.push(`${same.name}: ${same.weight}% → ${w.weight}%`); same.weight = w.weight }
      else if (!same) { changes.push(`New grade category ${w.name} (${w.weight}%)`); categories.push({ id: Math.random().toString(36).slice(2, 8), name: w.name, weight: w.weight, items: [] }) }
    }
    if (changes.length) patch.grading = { ...grading, categories }
  }
  if (s.people.length) {
    const people = peopleOf(info)
    const added = s.people.filter(p => !people.some(q => (p.email && q.email.toLowerCase() === p.email.toLowerCase()) || q.name.toLowerCase() === p.name.toLowerCase()))
    const updated = people.map(q => {
      const match = s.people.find(p => (p.email && q.email.toLowerCase() === p.email.toLowerCase()) || q.name.toLowerCase() === p.name.toLowerCase())
      if (match && match.hours && match.hours !== q.hours) { changes.push(`${q.name || q.email}'s office hours: ${match.hours}`); return { ...q, hours: match.hours } }
      return q
    })
    added.forEach(p => changes.push(`Add ${p.role ? `${p.role} ` : ''}${p.name || p.email}${p.hours ? ` (${p.hours})` : ''}`))
    if (added.length || updated.some((q, i) => q !== people[i])) patch.people = [...updated, ...added].slice(0, 12)
  }
  const current = info.aiPolicy === 'none' || info.aiPolicy === 'full' ? info.aiPolicy : 'hints'
  if (s.aiPolicy && s.aiPolicy !== current) { patch.aiPolicy = s.aiPolicy; changes.push(`AI help: ${current} → ${s.aiPolicy}`) }
  s.exams.forEach(e => changes.push(`Exam: ${e.title} on ${new Date(e.start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${e.room ? ` in ${e.room}` : ''}`))
  return { patch, changes }
}

/** What Mimir is asked to do with a course's syllabus. */
export function syllabusPrompt(course: string, book: string) {
  return [
    `Read the syllabus “${book}” of my ${course} course (study_read, all of it) and fill in the course for me with study_syllabus:`,
    `the grade weights by category, the professor's and TAs' names, emails and office hours, the exam dates and times (and rooms if given), and the AI policy:`,
    `"none" if AI tools aren't allowed for coursework, "full" if they're openly allowed, else "hints". Only include what the syllabus says. It waits in the Study tab for me to check.`,
  ].join('\n')
}
