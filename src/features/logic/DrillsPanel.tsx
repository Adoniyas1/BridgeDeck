import { useMemo, useState } from 'react'
import { Layers, RefreshCw } from 'lucide-react'
import { addCards, libraryStore } from '../study/state'
import { cardLine } from '../study/cards'
import { useStore } from '../../core/store'
import { checkDrill, makeDrill, rng, type Drill, type DrillKind, type Marked } from './drills'

const KINDS: Array<[DrillKind, string]> = [['base', 'Number bases'], ['twos', "Two's complement"], ['kmap', 'K-map minimisation']]

/** Practice questions for digital logic, marked as you go; a miss can become a flashcard. */
export default function Drills() {
  const [kind, setKind] = useState<DrillKind>('base')
  const [seed, setSeed] = useState(() => Date.now() % 100000)
  const rand = useMemo(() => rng(seed), [seed])
  const [drill, setDrill] = useState<Drill>(() => makeDrill('base', rng(Date.now() % 100000)))
  const [typed, setTyped] = useState('')
  const [marked, setMarked] = useState<Marked | null>(null)
  const [score, setScore] = useState({ right: 0, tried: 0 })
  const courses = useStore(libraryStore).library?.courses.filter(c => !c.archived).map(c => c.name) ?? []
  const [course, setCourse] = useState('')
  const [status, setStatus] = useState('')

  const next = (k = kind) => { setDrill(makeDrill(k, rand)); setTyped(''); setMarked(null); setStatus('') }
  function mark() {
    if (marked) return next()
    const m = checkDrill(drill, typed)
    setMarked(m)
    setScore(s => ({ right: s.right + (m.right ? 1 : 0), tried: s.tried + 1 }))
  }
  async function toCard() {
    const target = course || courses[0]
    if (!target) return setStatus('Add a course in Study first.')
    try { await addCards(target, [cardLine(drill.question, drill.answer)]); setStatus(`Added a card to ${target}.`) } catch (e) { setStatus(String(e)) }
  }

  return <div className="logic-drills">
    <div className="logic-drills-kinds">{KINDS.map(([k, label]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setSeed(s => s + 1); next(k) }}>{label}</button>)}
      <span className="grow" /><small>{score.tried ? `${score.right} of ${score.tried} right` : ''}</small></div>
    <p className="logic-drills-question">{drill.question}</p>
    <form onSubmit={e => { e.preventDefault(); mark() }} className="logic-drills-answer">
      <input autoFocus value={typed} disabled={!!marked} placeholder={drill.kind === 'kmap' ? "e.g. A'B + C" : 'Your answer'} onChange={e => setTyped(e.target.value)} />
      <button>{marked ? 'Next' : 'Check'}</button>
      <button type="button" className="ghost" title="Another question" onClick={() => next()}><RefreshCw size={14} /></button>
    </form>
    {marked && <p className={marked.right ? 'logic-drills-right' : 'logic-drills-wrong'}>{marked.message}</p>}
    {marked && !marked.right && <div className="logic-drills-card">
      {courses.length > 1 && <select value={course} onChange={e => setCourse(e.target.value)}>{courses.map(c => <option key={c}>{c}</option>)}</select>}
      <button className="ghost" onClick={() => void toCard()}><Layers size={14} />Make it a flashcard</button>
    </div>}
    {status && <p className="hint">{status}</p>}
    <p className="hint">K-maps: write a sum of products with ' for NOT (A'B + C); any equal expression counts if it’s as short as the minimal one.</p>
  </div>
}
