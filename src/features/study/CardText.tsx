import katex from 'katex'
import { convertFileSrc } from '@tauri-apps/api/core'
import 'katex/dist/katex.min.css'
import { displayMath, inline } from '../notes/model'

/** Engineering symbols typed in words, shown as symbols: "4.7 kohm" → "4.7 kΩ", "10 uF" → "10 µF". */
export function symbols(text: string) {
  return text
    .replace(/(\d)\s*(k|M|m)?ohms?\b/g, (_, d: string, p = '') => `${d} ${p}Ω`)
    .replace(/(\d)\s*u(F|H|A|V|s|m)\b/g, (_, d: string, u: string) => `${d} µ${u}`)
    .replace(/\bdeg\b/g, '°')
}

const math = (tex: string, displayMode: boolean) => katex.renderToString(tex, { throwOnError: false, displayMode, trust: false, maxExpand: 500 })

/** A flashcard side: $math$ and $$display math$$ typeset, **bold**, *italic*, `code`, symbols. Book
 *  links are left out (the review shows an "Open p. N" button for them). Nothing in a card can run:
 *  KaTeX escapes text and links are never followed from here. */
export function CardText({ text, className }: { text: string; className?: string }) {
  const clean = text.replace(/\s*\(\[[^\]]*\]\(book:[^)]*\)\)\s*$/, '').trim()
  const pictures = [...clean.matchAll(PICTURE)].map(m => ({ alt: m[1], src: pictureSrc(m[2]) })).filter(p => p.src)
  const words = clean.replace(PICTURE, '').trim()
  if (!pictures.length) return <Words text={words} className={className} />
  return <div className={className}>
    {words && <Words text={words} />}
    {pictures.map((p, i) => <img key={i} className="card-picture" src={p.src!} alt={p.alt || 'Picture'} />)}
  </div>
}

/** `![alt](bdimg:<course>/<file>)`: a picture in the course's Cards folder. */
const PICTURE = /!\[([^\]]*)\]\(bdimg:([^)\s]+)\)/g

/** The address the book scheme serves a card picture at (study.rs only serves Cards/ images). */
function pictureSrc(ref: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(ref) } catch { return null }
  const [course, file, ...rest] = decoded.split('/')
  if (!course || !file || rest.length || !/\.(png|jpe?g|webp)$/i.test(file)) return null
  return convertFileSrc(`${course}/Cards/${file}`, 'bdbook')
}

function Words({ text, className }: { text: string; className?: string }) {
  const display = displayMath(text)
  if (display) return <div className={className} dangerouslySetInnerHTML={{ __html: math(display, true) }} />
  return <p className={className}>{inline(text).map((piece, i) => {
    switch (piece.kind) {
      case 'math': return <span key={i} dangerouslySetInnerHTML={{ __html: math(piece.text, false) }} />
      case 'bold': return <strong key={i}>{symbols(piece.text)}</strong>
      case 'italic': return <em key={i}>{symbols(piece.text)}</em>
      case 'code': return <code key={i}>{piece.text}</code>
      case 'strike': return <s key={i}>{symbols(piece.text)}</s>
      default: return <span key={i}>{symbols(piece.text)}</span>
    }
  })}</p>
}

/** A picture reference for a card line. */
export const pictureRef = (course: string, file: string) => `![](bdimg:${encodeURIComponent(course)}/${encodeURIComponent(file)})`

/** The book page a card came from (its "([Book, p. 214](book:…))" ending), if any. */
export { cardSource } from './cards'
