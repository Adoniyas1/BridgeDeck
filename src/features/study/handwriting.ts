/** Reading handwritten notes: what text recognition (or Mimir) read, checked before it becomes a
 *  note. Math is written as $…$ or $$…$$; lines whose math doesn't typeset are flagged. */

/** Lines with math KaTeX can't read (likely misread), by line number (from 0). */
export function badMathLines(text: string, check: (tex: string, display: boolean) => boolean): number[] {
  const out: number[] = []
  text.split('\n').forEach((line, i) => {
    const pieces = [...line.matchAll(/\$\$(.+?)\$\$|\$([^$\n]+?)\$/g)]
    if (pieces.some(m => !check((m[1] ?? m[2]).trim(), !!m[1]))) out.push(i)
  })
  return out
}

/** Words recognition was unsure of: very short garbage, stray symbols, mixed letters and digits. */
export function doubtfulLines(text: string): number[] {
  return text.split('\n').flatMap((line, i) => {
    const words = line.trim().split(/\s+/).filter(Boolean)
    if (!words.length || /\$/.test(line)) return []
    // Subscripts like I1 or R2 are fine; letters and digits jumbled together ("x7q") aren't.
    const odd = words.filter(w => /[^\w.,;:!?'"()\-–/+=*<>%°]/.test(w) || /[a-z]\d+[a-z]|\d[a-z]{3,}/i.test(w) || (w.length === 1 && !/[aAI\d+\-=*/<>]/.test(w)))
    return odd.length / words.length > 0.34 ? [i] : []
  })
}

/** What Mimir is asked: read the photo with its vision model and write the notes as Markdown. */
export function handwritingPrompt(course: string, file: string, folder: string) {
  return [
    `Read my handwritten notes in the photo “${file}” of ${course} (study_photo). Write them out faithfully as Markdown: headings for titles, lists for lists, math as LaTeX in $…$ (or $$…$$ on its own line), and [figure: what it shows] where there's a drawing.`,
    `Don't add anything that isn't on the page; mark a word you can't read as [?]. Save it with note_create (title “${file.replace(/\.[^.]+$/, '')} — notes”, folder “${folder}”) and tell me what you weren't sure of.`,
  ].join('\n')
}
