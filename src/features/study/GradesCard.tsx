import { useEffect, useRef, useState } from 'react'
import { Calculator, CloudDownload, Plus, Sparkles, Trash2 } from 'lucide-react'
import { studyPatchCourseInfo, type StudyCourse } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { errorText } from '../../core/util'
import { Card, SectionTitle } from '../../ui'
import { canvasStore } from './canvasStore'
import { categoryPercent, currentPercent, LETTERS, letterFor, neededAverage, readGrading, TEMPLATES, withCanvasScores, type GradeCategory, type Grading } from './grades'
import { useAssignments } from './assignments'
import { belongsTo } from './canvas'
import { refreshLibrary } from './state'

const id = () => Math.random().toString(36).slice(2, 8)
const pct = (n: number | null) => n == null ? '—' : `${n.toFixed(1)}%`

/** The course's grade from its syllabus weights and your scores, the grade Canvas shows, and what
 *  you need on what's left. */
export function GradesCard({ course, onStatus }: { course: StudyCourse; onStatus: (s: string) => void }) {
  const canvas = useStore(canvasStore).courses.find(c => c.id === course.info.canvasId)
  const [grading, setGrading] = useState<Grading>(() => readGrading(course.info.grading))
  useEffect(() => setGrading(readGrading(course.info.grading)), [course.info.grading])
  const target = grading.goal ?? 90
  const setTarget = (goal: number) => update({ ...grading, goal }, true)
  // Canvas assignments of this course that have been graded.
  const assignments = useAssignments()
  const scored = assignments.filter(a => a.source === 'canvas' && a.score != null && (a.points ?? 0) > 0 && belongsTo({ name: course.name, code: course.info.code, canvasCode: course.info.canvasCode }, a.course))
    .map(a => ({ id: a.id, title: a.title, score: a.score!, points: a.points! }))
  function fillFromCanvas() {
    const { grading: next, filled } = withCanvasScores(grading, scored, id)
    if (filled) update(next, true)
    onStatus(filled ? `Filled in ${filled} score${filled === 1 ? '' : 's'} from Canvas.` : 'The sheet already has every Canvas score.')
  }
  const timer = useRef<number>()

  function update(next: Grading, now = false) {
    setGrading(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void studyPatchCourseInfo(course.name, { grading: next }).then(() => refreshLibrary()).catch(e => onStatus(errorText(e, 'Couldn’t save the grades'))), now ? 0 : 800)
  }
  const setCategory = (cid: string, patch: Partial<GradeCategory>) => update({ ...grading, categories: grading.categories.map(c => c.id === cid ? { ...c, ...patch } : c) })
  const current = currentPercent(grading)
  const totalWeight = grading.categories.reduce((s, c) => s + c.weight, 0)
  const ungraded = grading.categories.flatMap(c => c.items.filter(i => i.got == null).map(i => ({ ...i, category: c.name })))

  const behind = current != null && current < target
  return <Card><SectionTitle title="Grade" subtitle={current != null ? `${pct(current)} · ${letterFor(current)} from your scores${canvas?.score != null ? ` · Canvas says ${canvas.score.toFixed(1)}%${canvas.grade ? ` (${canvas.grade})` : ''}` : ''}` : canvas?.score != null ? `Canvas says ${canvas.score.toFixed(1)}%${canvas.grade ? ` (${canvas.grade})` : ''}` : 'Add the syllabus’s weights and your scores'} action={<Calculator size={18} />} />
    {!grading.categories.length ? <div className="grade-start">
      <p className="hint">Start from the syllabus’s grading:</p>
      <div className="actions">{TEMPLATES.map(t => <button key={t.name} className="secondary" onClick={() => update({ categories: t.categories.map(([name, weight]) => ({ id: id(), name, weight, items: [] })) }, true)}>{t.name}</button>)}
        <button className="secondary" onClick={() => update({ categories: [{ id: id(), name: 'Category', weight: 100, items: [] }] }, true)}>My own</button></div>
    </div> : <>
      <div className="grade-cats">{grading.categories.map(c => <div key={c.id} className="grade-cat">
        <div className="grade-cat-head">
          <input className="grade-name" value={c.name} onChange={e => setCategory(c.id, { name: e.target.value })} />
          <label><input className="num" type="number" min={0} max={100} value={c.weight} onChange={e => setCategory(c.id, { weight: Math.max(0, Number(e.target.value) || 0) })} />%</label>
          <label title="How many of the lowest scores the syllabus drops">drop<input className="num" type="number" min={0} max={20} value={c.drop ?? 0} onChange={e => setCategory(c.id, { drop: Math.max(0, Math.min(20, Number(e.target.value) || 0)) || undefined })} /></label>
          <span className="grade-cat-pct">{pct(categoryPercent(c))}</span>
          <button className="cal-icon" title={`Remove ${c.name}`} onClick={() => update({ ...grading, categories: grading.categories.filter(x => x.id !== c.id) })}><Trash2 size={13} /></button>
        </div>
        {c.items.map(i => <div key={i.id} className="grade-item">
          <input value={i.name} onChange={e => setCategory(c.id, { items: c.items.map(x => x.id === i.id ? { ...x, name: e.target.value } : x) })} />
          <input className="num" type="number" placeholder="score" value={i.got ?? ''} onChange={e => setCategory(c.id, { items: c.items.map(x => x.id === i.id ? { ...x, got: e.target.value === '' ? null : Number(e.target.value) } : x) })} />
          <span>/</span>
          <input className="num" type="number" min={0} value={i.max} onChange={e => setCategory(c.id, { items: c.items.map(x => x.id === i.id ? { ...x, max: Math.max(0, Number(e.target.value) || 0) } : x) })} />
          <button className={`cal-icon${i.extra ? ' on' : ''}`} title={i.extra ? 'Extra credit (adds points, not out of)' : 'Make it extra credit'} onClick={() => setCategory(c.id, { items: c.items.map(x => x.id === i.id ? { ...x, extra: !x.extra || undefined } : x) })}><Sparkles size={12} /></button>
          <button className="cal-icon" title="Remove" onClick={() => setCategory(c.id, { items: c.items.filter(x => x.id !== i.id) })}><Trash2 size={12} /></button>
        </div>)}
        <button className="ghost grade-add" onClick={() => setCategory(c.id, { items: [...c.items, { id: id(), name: `${c.name.replace(/s$/, '')} ${c.items.length + 1}`, got: null, max: c.name.toLowerCase().startsWith('home') ? 10 : 100 }] })}><Plus size={12} />Score</button>
      </div>)}</div>
      <div className="actions">
        <button className="ghost" onClick={() => update({ ...grading, categories: [...grading.categories, { id: id(), name: 'Category', weight: 0, items: [] }] })}><Plus size={13} />Category</button>
        {scored.length > 0 && <button className="ghost" title="Put Canvas's graded scores into this sheet" onClick={fillFromCanvas}><CloudDownload size={13} />Fill in from Canvas</button>}
        <label title="Weights: each category is its % of the grade. Points: all points added up."><select value={grading.mode ?? 'weights'} onChange={e => update({ ...grading, mode: e.target.value === 'points' ? 'points' : undefined }, true)}><option value="weights">By weights</option><option value="points">By total points</option></select></label>
        {grading.mode !== 'points' && totalWeight !== 100 && <span className="hint">Weights add up to {totalWeight}%, not 100%.</span>}
      </div>
      {behind && <p className="cal-error">Below your goal of {target}% ({letterFor(target)}): {pct(current)} now.</p>}
      {ungraded.length > 0 && current != null && <div className="grade-need">
        <strong>What you need</strong> for <select value={target} onChange={e => setTarget(Number(e.target.value))}>{LETTERS.slice(0, 4).map(([l, min]) => <option key={l} value={min}>{l} ({min}%)</option>)}</select>
        {(() => {
          const need = neededAverage(grading, target)
          if (need == null) return null
          return <>
            <p className={`grade-need-line ${need > 100 ? 'bad' : need <= 0 ? 'ok' : ''}`}>{need > 100 ? `Out of reach: it would take ${need.toFixed(0)}% on everything left.` : need <= 0 ? 'You’re there whatever happens on what’s left.' : <>An average of <b>{need.toFixed(1)}%</b> on everything left:</>}</p>
            {need > 0 && need <= 100 && <ul>{ungraded.map(i => <li key={i.id}><span>{i.name} <small>({i.category})</small></span><b>{((need / 100) * i.max).toFixed(1)}/{i.max}</b></li>)}</ul>}
            <p className="hint">That’s the same percent on each item left; doing better on one leaves less to do on the others.</p>
          </>
        })()}
      </div>}
    </>}
  </Card>
}
