/** Practice exams: the course's old exams (from Canvas or added), with the homework problems from
 *  the chapters the exam covers mixed in a random order, as one PDF in the course. */

import type { StudyBook } from '../../lib/bridge'
import { coversChapter } from './cards'
import { expandProblems, type RatedProblem } from './problems'

export const isOldExam = (b: StudyBook) => b.kind === 'pdf' && /\b(exam|midterm|final|quiz|practice|test)\b/i.test(b.title) && !/^practice exam/i.test(b.title)

/** A seeded shuffle, so the same seed gives the same paper. */
export function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items]
  let x = seed || 1
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Problems for the paper: from the course's assignments, in the chapters covered (all of them when
 *  it doesn't say), the ones marked stuck or needing help first, then a random mix; `count` in all. */
export function practiceProblems(assignments: Array<{ title: string }>, ratings: RatedProblem[], covers: string, count: number, seed: number): string[] {
  const inScope = (section: string) => !covers.trim() || !section || coversChapter(`: ${section.split('.')[0]}`, covers)
  const label = (section: string, number: string) => section ? `Section ${section}, problem ${number}` : `Problem ${number}`
  const hard = ratings.filter(r => inScope(r.section)).map(r => label(r.section, r.number))
  const all = assignments.flatMap(a => expandProblems(a.title)).filter(p => inScope(p.section)).map(p => label(p.section, p.number))
  const picked = [...new Set([...shuffled(hard, seed).slice(0, Math.ceil(count / 2)), ...shuffled(all, seed + 1)])].slice(0, count)
  return shuffled(picked, seed + 2)
}

/** What Mimir is asked for: new questions like the exam's, each answer worked out in Python. */
export function practiceQuestionsPrompt(course: string, exam: string, covers: string) {
  return [
    `Write a practice ${exam} for ${course}${covers ? ` covering ${covers}` : ''}: 6 questions like an exam's, mixing short and longer ones, using my textbook (study_search) for what's covered.`,
    `Work out every numerical answer with run_python before giving it. Put all the questions first, then a line "Answers", then the worked answers, so I can try them before looking.`,
  ].join('\n')
}
