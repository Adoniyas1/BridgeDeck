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

/** Words fixed by hand after reading a photo: single words the reader got wrong and what they
 *  were, found by lining up the words read with the words kept (longest common run). Kept with the
 *  course (`handwriting`: "misread=>right"), so the next photo is read with them fixed, and the
 *  right words are given to Apple Vision as words to expect. */
export function corrections(before: string, after: string): Array<[string, string]> {
  const a = before.split(/\s+/).filter(Boolean).slice(0, 1500), b = after.split(/\s+/).filter(Boolean).slice(0, 1500)
  const n = a.length, m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: Array<[string, string]> = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; continue }
    // One word swapped for one word: a fix. Anything else (words added, removed) is just editing.
    if (lcs[i + 1][j + 1] === lcs[i][j] && i + 1 <= n && j + 1 <= m) {
      const [wrong, right] = [a[i].replace(/^[^\w$\\]+|[^\w$}]+$/g, ''), b[j].replace(/^[^\w$\\]+|[^\w$}]+$/g, '')]
      if (wrong && right && wrong !== right && !/\$/.test(wrong + right) && right.length >= 2 && !out.some(([w]) => w === wrong)) out.push([wrong, right])
      i++; j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++
    else j++
  }
  return out
}

/** The course's saved fixes merged with new ones (newest win), at most 300. */
export function mergeFixes(saved: unknown, fresh: Array<[string, string]>): string[] {
  const list = Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string' && x.includes('=>')) : []
  const map = new Map(list.map(x => { const [w, r] = x.split('=>').map(s => s.trim()); return [w, r] as const }))
  for (const [w, r] of fresh) map.set(w, r)
  return [...map].slice(-300).map(([w, r]) => `${w}=>${r}`)
}
