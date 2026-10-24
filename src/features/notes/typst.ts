/** A note as Typst source, for a clean typeset PDF (src-tauri/src/typst_export.rs): headings,
 *  lists, checklists, quotes, code, and math written as LaTeX ($…$, $$…$$) typeset by mitex. Two
 *  looks: 'clean' (Typst's book font) or 'hand' (the Kalam handwriting font). */

import type { Note, NoteBlock } from '../../lib/bridge'
import { displayMath, indentOf, inline, noteTitle, visible } from './model'
import { graphSvg } from './plot'

export type TypstStyle = 'clean' | 'hand'

/** Text as Typst markup with nothing special in it. */
export const escapeText = (text: string) => text.replace(/[\\#$*_@<>`[\]~=/+\-"]/g, c => `\\${c}`)

/** LaTeX for mitex, as a Typst raw string (backticks can't appear inside one). */
const raw = (tex: string) => `\`${tex.replace(/`/g, "'")}\``

function inlineTypst(text: string): string {
  return inline(text).map(p => {
    switch (p.kind) {
      case 'bold': return `*${escapeText(p.text)}*`
      case 'italic': return `_${escapeText(p.text)}_`
      case 'strike': return `#strike[${escapeText(p.text)}]`
      case 'code': return `#raw(${JSON.stringify(p.text)})`
      case 'math': return `#mi(${raw(p.text)})`
      case 'link': return p.href?.startsWith('http') ? `#link(${JSON.stringify(p.href)})[${escapeText(p.text)}]` : escapeText(p.text)
      case 'wikilink': return escapeText(p.text)
      case 'tag': return escapeText(`#${p.text}`)
      default: return escapeText(p.text)
    }
  }).join('')
}

function blockTypst(b: NoteBlock, number: number): string {
  const pad = '  '.repeat(indentOf(b))
  const full = b.text.replace(/\s*<!--[\s\S]*?-->/g, '')
  // Headings and list items are one line each.
  const text = ['p', 'code', 'python', 'calc', 'graph', 'quote'].includes(b.kind) ? full : full.replace(/\s*\n\s*/g, ' ')
  switch (b.kind) {
    case 'h1': return `= ${inlineTypst(text)}`
    case 'h2': return `== ${inlineTypst(text)}`
    case 'h3': return `=== ${inlineTypst(text)}`
    case 'li': return `${pad}- ${inlineTypst(text)}`
    case 'ol': return `${pad}${number}. ${inlineTypst(text)}`
    case 'todo': return `${pad}- ${b.checked ? '☑' : '☐'} ${inlineTypst(text)}`
    case 'quote': return `#quote(block: true)[${inlineTypst(text)}]`
    case 'graph': { const svg = graphSvg(text); if (svg) return `#align(center, image(bytes(${JSON.stringify(svg)}), format: "svg", width: 90%))`; return `#raw(${JSON.stringify(text)}, block: true)` }
    case 'code': case 'python': case 'calc': return `#raw(${JSON.stringify(text)}, block: true${b.kind === 'python' ? ', lang: "python"' : ''})`
    case 'drawing': case 'ink': case 'image': return `#text(fill: gray)[(${b.kind === 'ink' ? 'handwriting' : b.kind === 'image' ? 'picture' : 'drawing'}: see the note in BridgeDeck)]`
    case 'locked': return ''
    default: {
      const math = displayMath(text)
      if (math !== null) return `#mitex(${raw(math)})`
      // A line break inside a paragraph stays a line break.
      return text.split('\n').map(inlineTypst).join(' \\\n')
    }
  }
}

/** The same source with math left as LaTeX text, for when the mitex package can't be fetched. */
export const withoutMitex = (source: string) => source.replace('#import "@preview/mitex:0.2.5": mitex, mi', '#let mitex(x) = block(raw(x.text))\n#let mi(x) = raw(x.text)')

export function noteTypst(note: Note, style: TypstStyle = 'clean'): string {
  const blocks = visible(note)
  const lines: string[] = [
    '#import "@preview/mitex:0.2.5": mitex, mi',
    '#set page(paper: "us-letter", margin: (x: 2.2cm, y: 2.2cm), numbering: "1")',
    style === 'hand' ? '#set text(font: ("Kalam", "New Computer Modern"), size: 12.5pt)' : '#set text(font: "New Computer Modern", size: 11pt)',
    '#set par(justify: false, leading: 0.7em)',
    '#show heading: set block(above: 1.2em, below: 0.6em)',
    '',
    `#align(center, text(size: 18pt, weight: "bold")[${escapeText(noteTitle(note))}])`,
    '',
  ]
  let number = 0
  for (const b of blocks) {
    number = b.kind === 'ol' ? number + 1 : 0
    const out = blockTypst(b, number)
    if (!out.trim()) continue
    lines.push(out)
    // List items stay together; everything else is its own paragraph.
    if (!['li', 'ol', 'todo'].includes(b.kind)) lines.push('')
  }
  return lines.join('\n') + '\n'
}
