/** A course's homework schedule from a photo of the sheet: ChatGPT (in the side panel) reads the
 *  handwriting into plain lines, and these turn them into assignments with dates.
 *
 *  The sheets list class days, not dates ("M 1", "W 2", "Th 3", with week numbers in the margin
 *  now and then), so the dates come from the semester's first week: a new week starts when the
 *  weekday goes back (Th → M) or when a week number is written. */

import { addDays, startOfDay } from '../calendar/model'

export type HomeworkRow = { week: number | null; day: number; label: string; text: string; note: string }
export type DatedHomework = HomeworkRow & { date: number }

/** What Mimir is asked for: read the photo (already copied into the course) with its own vision
 *  model, and suggest each deadline, which waits in the Study tab for approval. */
export function mimirHomeworkPrompt(course: string, file: string) {
  return [
    `The photo “${file}” in my ${course} course is my homework schedule. Look at it with study_photo (course “${course}”, file “${file}”) and read every row.`,
    `The rows give class days ("M 1", "W 2", "Th 3"), not dates: use study_schedule for my class times and the semester's start to work out each date.`,
    `Then suggest each assignment with study_suggest (kind "deadline", course "${course}", the work as the title, e.g. "Ch 10.1: 3, 7-15 odd"), due at 11:59 pm on its day, and any exam written on the sheet with kind "exam".`,
    `Finish with a short list of what you suggested and anything you couldn't read.`,
  ].join('\n')
}

/** What ChatGPT is asked for. */
export function homeworkPrompt(course: string) {
  return [
    `This photo is my homework schedule for ${course}. Read every row of the handwriting carefully and write it out as plain lines in one code block, nothing else, one line per row:`,
    '',
    'WEEK | DAY | WORK | NOTE',
    '',
    '- WEEK: the week number if one is written in the margin for that row, else leave it empty.',
    '- DAY: the weekday and class number as written, like "M 1", "W 2", "Th 3".',
    '- WORK: the assignment exactly as written, e.g. "Ch 10.1: 3, 7-15 (odd), 18; Ch 10.2: 2, 5". Keep "(odd)" and letters like 13a.',
    '- NOTE: anything else written for that day, like "Exam 1" or "Labor Day", else empty.',
    '',
    'If the first and last days of the semester are written anywhere in the photo, start with one line: SEMESTER | MM/DD/YYYY | MM/DD/YYYY',
  ].join('\n')
}

const DAYS: Array<[RegExp, number]> = [
  [/^(m|mo|mon|monday)$/i, 1], [/^(t|tu|tue|tues|tuesday)$/i, 2], [/^(w|we|wed|weds|wednesday)$/i, 3],
  [/^(th|r|thu|thur|thurs|thursday)$/i, 4], [/^(f|fr|fri|friday)$/i, 5], [/^(sa|sat|saturday)$/i, 6], [/^(su|sun|sunday)$/i, 7],
]

/** "Th 3" → Thursday (4), label "Th 3". */
function readDay(text: string): { day: number; label: string } | null {
  const m = text.trim().match(/^([A-Za-z]{1,9})\.?\s*(\d{0,3})$/)
  const day = m && DAYS.find(([re]) => re.test(m[1]))?.[1]
  return m && day ? { day, label: `${m[1]}${m[2] ? ` ${m[2]}` : ''}` } : null
}

function readDate(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (!m) return null
  const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3])
  const date = new Date(year, Number(m[1]) - 1, Number(m[2]))
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

/** The lines ChatGPT wrote (or that were typed or pasted), and the semester's first day if given. */
export function readHomework(text: string): { rows: HomeworkRow[]; semesterStart: number | null } {
  const rows: HomeworkRow[] = []
  let semesterStart: number | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '').replace(/^\||\|$/g, '')
    if (!line.includes('|')) continue
    const cells = line.split('|').map(c => c.trim())
    if (/^semester$/i.test(cells[0])) { semesterStart = readDate(cells[1] ?? '') ?? semesterStart; continue }
    if (/^week$/i.test(cells[0]) || /^-+$/.test(cells[0].replace(/[\s:]/g, ''))) continue
    // WEEK | DAY | WORK | NOTE, or DAY | WORK | NOTE when the week column was left out.
    const withWeek = readDay(cells[1] ?? '') && !readDay(cells[0])
    const [weekCell, dayCell, work, note] = withWeek ? cells : ['', ...cells]
    const day = readDay(dayCell ?? '')
    if (!day || (!work && !note)) continue
    const week = Number((weekCell ?? '').replace(/\D/g, ''))
    rows.push({ week: week > 0 && week < 60 ? week : null, ...day, text: work ?? '', note: note ?? '' })
  }
  return { rows, semesterStart }
}

/** The Monday of the week `date` is in. */
export function mondayOf(date: number) {
  const d = new Date(startOfDay(date))
  return addDays(d.getTime(), -((d.getDay() + 6) % 7))
}

/** Dates for the rows, counting weeks from the semester's first week. */
export function dateHomework(rows: HomeworkRow[], semesterStart: number): DatedHomework[] {
  const monday = mondayOf(semesterStart)
  let week = 1
  let last = 0
  return rows.map(row => {
    if (row.week) week = row.week
    else if (last && row.day <= last) week++
    last = row.day
    return { ...row, week, date: addDays(monday, (week - 1) * 7 + row.day - 1) }
  })
}

/** The assignment's title: "M 1 · Ch 10.1: 3, 7-15 (odd)…". */
export function homeworkTitle(row: HomeworkRow) {
  return [row.label, row.text || row.note].filter(Boolean).join(' · ')
}
