/** What Mimir is asked to do with a lecture: read its transcript, then summarise it into the dated
 *  note and suggest cards and new words (which wait for approval in the Study tab). */
export function lectureSummaryPrompt(course: string, file: string) {
  return [
    `Read my ${course} lecture “${file}” with study_lecture.`,
    `Then: 1) write a short summary (the main ideas, in order, with [mm:ss] times) and a list of key terms with one-line meanings, and add both to the lecture's note under "Summary" with notes_append;`,
    `2) suggest 5 to 15 flashcards from it with flashcards_add (course “${course}”); 3) list any words the transcript seems to have misheard, as "heard => written", so I can add them to the course's word list.`,
  ].join('\n')
}
