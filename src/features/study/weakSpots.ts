import type { LectureSidecar } from '../../lib/bridge'
import { coversChapter, type Mastery } from './cards'
import type { Exam } from './exams'
import { lectureLink } from './model'
import type { Mistake } from './mistakes'
import type { RatedProblem } from './problems'

/**
 * Where a course is going badly, from everything that shows it: chapters whose flashcards you
 * don't remember, lecture moments marked "Lost here", homework problems marked stuck or needing
 * help, and mistakes from graded work. One short list, weakest first, for "Study these next".
 */

export type WeakSpot =
  | { kind: 'chapter'; key: string; label: string; recall: number; cards: number }
  | { kind: 'lecture'; key: string; file: string; t: number; text: string }
  | { kind: 'problem'; key: string; rating: RatedProblem['rating']; assignment: string; section: string; number: string }
  | { kind: 'mistake'; key: string; text: string; assignment: string }

export type WeakInput = {
  mastery: Mastery[]
  lectures: Array<{ file: string; modified: number; sidecar: LectureSidecar | null }>
  ratings: RatedProblem[]
  mistakes: Mistake[]
}

/** Chapters below this recall (with enough cards to tell) count as weak. */
export const WEAK_RECALL = 0.6
const MIN_CARDS = 3

/** What was being said around a moment of a lecture: the transcript from a little before to a little after. */
export function lectureSnippet(segments: LectureSidecar['segments'], t: number, before = 20, after = 15, max = 240): string {
  const text = (segments ?? []).filter(s => s.end >= t - before && s.start <= t + after).map(s => s.text.trim()).filter(Boolean).join(' ')
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

export function weakSpots({ mastery, lectures, ratings, mistakes }: WeakInput): WeakSpot[] {
  const chapters: WeakSpot[] = mastery
    .filter(m => m.label !== 'Other cards' && m.cards >= MIN_CARDS && m.recall < WEAK_RECALL)
    .sort((a, b) => a.recall - b.recall).slice(0, 4)
    .map(m => ({ kind: 'chapter', key: `c:${m.label}`, label: m.label, recall: m.recall, cards: m.cards }))
  const problems: WeakSpot[] = ratings.slice(0, 5)
    .map(r => ({ kind: 'problem', key: `p:${r.id}`, rating: r.rating, assignment: r.assignment, section: r.section, number: r.number }))
  const marks: WeakSpot[] = [...lectures].sort((a, b) => b.modified - a.modified)
    .flatMap(l => (l.sidecar?.markers ?? []).map(m => ({ kind: 'lecture' as const, key: `l:${l.file}@${m.t}`, file: l.file, t: m.t, text: m.note?.trim() || lectureSnippet(l.sidecar?.segments, m.t) })))
    .slice(0, 5)
  const recent: WeakSpot[] = mistakes.slice(0, 3).map(m => ({ kind: 'mistake', key: `m:${m.id}`, text: m.text, assignment: m.assignment }))
  // Stuck problems and the weakest chapters first; then lectures, problems that needed help, mistakes.
  const stuck = problems.filter(p => p.kind === 'problem' && p.rating === 'stuck')
  return [...chapters.slice(0, 2), ...stuck, ...chapters.slice(2), ...marks, ...problems.filter(p => !stuck.includes(p)), ...recent]
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** One line describing a weak spot, for Mimir and the pre-exam pack. */
export function weakSpotText(s: WeakSpot): string {
  switch (s.kind) {
    case 'chapter': return `${s.label}: I remember about ${Math.round(s.recall * 100)}% of its ${s.cards} flashcards`
    case 'lecture': return `Lost in lecture “${s.file.replace(/\.[^.]+$/, '')}” at ${clock(s.t)}${s.text ? `, around: “${s.text}”` : ''}`
    case 'problem': return `${s.rating === 'stuck' ? 'Stuck on' : 'Needed help with'} problem ${s.section ? `${s.section} ` : ''}#${s.number} from “${s.assignment}”`
    case 'mistake': return `A mistake from ${s.assignment ? `“${s.assignment}”` : 'graded work'}: ${s.text}`
  }
}

/** What Mimir is asked for practice aimed at exactly these. */
export function weakSpotsPrompt(course: string, spots: WeakSpot[], exam?: string): string {
  return [
    `Here is where I'm weak in ${course}${exam ? `, before ${exam}` : ''}:`,
    ...spots.map(s => `- ${weakSpotText(s)}`),
    '',
    `Make me a short practice set aimed at exactly these, weakest first. For each: find the matching part of my textbook with study_search and read it with study_read; explain the idea in a few lines with the book and page; then give 2 practice problems like it, with full worked solutions whose numbers you checked with run_python. Put the solutions after all the problems so I can try first.`,
  ].join('\n')
}

/** The weak spots an exam is on: chapters and homework sections it covers (all of them when it
 *  doesn't say), and every lecture moment and mistake, which say nothing of chapters. */
export function forExam(spots: WeakSpot[], covers: string): WeakSpot[] {
  if (!covers.trim()) return spots
  return spots.filter(s => s.kind === 'chapter' ? coversChapter(s.label, covers) : s.kind === 'problem' ? !s.section || coversChapter(s.section, covers) : true)
}

/** The pre-exam pack: one checklist note with the exam's weak spots (each linked to the book page
 *  or lecture moment), what to do before the day and what to bring. */
export function examPackMarkdown(course: string, exam: Pick<Exam, 'title' | 'start' | 'end' | 'room' | 'allowed' | 'covers'>, spots: WeakSpot[], chapterLink: (label: string) => string | null, leeches: number): string {
  const when = new Date(exam.start).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const minutes = Math.round((exam.end - exam.start) / 60_000)
  const chapters = spots.filter(s => s.kind === 'chapter'), problems = spots.filter(s => s.kind === 'problem')
  const marks = spots.filter(s => s.kind === 'lecture'), mistakes = spots.filter(s => s.kind === 'mistake')
  const section = (title: string, lines: string[]) => lines.length ? [`### ${title}`, ...lines, ''] : []
  return [
    `## ${exam.title}`,
    [when, exam.room && `in ${exam.room}`, minutes > 0 && `${minutes} minutes`].filter(Boolean).join(' · '),
    exam.covers ? `Covers ${exam.covers}.` : '',
    '',
    ...section('Chapters you know least', chapters.map(s => { const link = s.kind === 'chapter' ? chapterLink(s.label) : null; return `- [ ] ${link ? `[${weakSpotText(s)}](${link})` : weakSpotText(s)}` })),
    ...section('Problems to redo', problems.map(s => `- [ ] ${weakSpotText(s)}`)),
    ...section('Lecture moments to replay', marks.map(s => s.kind === 'lecture' ? `- [ ] [${s.file.replace(/\.[^.]+$/, '')} at ${clock(s.t)}](${lectureLink(course, s.file, Math.max(0, s.t - 20))})${s.text ? ` ${s.text}` : ''}` : '')),
    ...section('Mistakes not to repeat', mistakes.map(s => `- ${s.kind === 'mistake' ? s.text : ''}`)),
    '### Before the day',
    `- [ ] Review the flashcards from the chapters it covers (Study → ${course} → the exam card)`,
    ...(leeches ? [`- [ ] The ${leeches} card${leeches === 1 ? '' : 's'} you keep forgetting`] : []),
    `- [ ] A practice exam, timed${minutes > 0 ? ` (${minutes} minutes)` : ''}, closed book`,
    '- [ ] Fill in the formula sheet',
    '- [ ] Sleep: a full night before beats a late one studying',
    '',
    '### Bring',
    ...(exam.allowed ? exam.allowed.split(/[,;]/).map(a => `- [ ] ${a.trim()}`).filter(l => l.length > 6) : []),
    '- [ ] Student ID, pencils and a spare pen',
    '',
  ].join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Exams starting within this long get the pack reminder and the card scoped to them. */
export const PACK_LEAD = 3 * 86_400_000
