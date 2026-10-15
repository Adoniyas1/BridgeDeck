import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CircleDot, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { analyze, exampleFsm, readWhen, showWhen, validName, type Bit, type Fsm, type FsmState, type FsmTransition } from './fsm'
import { newId } from './model'

const R = 34

/** A state diagram to draw, and what it takes to build it: the state table, the flip-flop
 *  equations and the circuit (7474 D flip-flops and gates). */
export default function FsmEditor({ fsm, onChange, onBuild }: { fsm: Fsm | undefined; onChange: (next: Fsm) => void; onBuild: (fsm: Fsm) => void }) {
  if (!fsm) return <div className="fsm-empty">
    <CircleDot size={28} />
    <p>Draw a state machine (states and the arrows between them), and BridgeDeck works out the state table, the flip-flop equations and the circuit with 7474 flip-flops.</p>
    <div className="actions">
      <button onClick={() => onChange(exampleFsm())}><Sparkles size={14} /> Start from an example (detect two 1s in a row)</button>
      <button className="ghost" onClick={() => onChange({ kind: 'moore', inputs: ['X'], outputs: ['Z'], states: [{ id: newId('q'), name: 'S0', x: 160, y: 160, out: { Z: 0 } }], transitions: [], start: '' })}><Plus size={14} /> Start empty</button>
    </div>
  </div>

  return <Editor fsm={fsm} onChange={onChange} onBuild={onBuild} />
}

function Editor({ fsm, onChange, onBuild }: { fsm: Fsm; onChange: (next: Fsm) => void; onBuild: (fsm: Fsm) => void }) {
  const svg = useRef<SVGSVGElement>(null)
  const [selected, setSelected] = useState<{ kind: 'state' | 'arrow'; id: string } | null>(null)
  /** Drawing an arrow: from this state to the next one clicked. */
  const [linking, setLinking] = useState<string | null>(null)
  const [mouse, setMouse] = useState({ x: 0, y: 0 })
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const analysis = useMemo(() => analyze(fsm), [fsm])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setLinking(null) }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const start = fsm.start || fsm.states[0]?.id
  const set = (patch: Partial<Fsm>) => onChange({ ...fsm, ...patch })
  const point = (e: { clientX: number; clientY: number }) => { const r = svg.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  const byId = (id: string) => fsm.states.find(s => s.id === id)
  const setState = (id: string, patch: Partial<FsmState>) => set({ states: fsm.states.map(s => (s.id === id ? { ...s, ...patch } : s)) })
  const setArrow = (id: string, patch: Partial<FsmTransition>) => set({ transitions: fsm.transitions.map(t => (t.id === id ? { ...t, ...patch } : t)) })

  function addState(at: { x: number; y: number }) {
    const used = new Set(fsm.states.map(s => s.name))
    let n = 0
    while (used.has(`S${n}`)) n++
    const s: FsmState = { id: newId('q'), name: `S${n}`, x: Math.round(at.x), y: Math.round(at.y), out: Object.fromEntries(fsm.outputs.map(o => [o, 0 as Bit])) }
    set({ states: [...fsm.states, s], start: fsm.start || s.id })
    setSelected({ kind: 'state', id: s.id })
  }

  function link(to: string) {
    const from = linking!
    setLinking(null)
    // The first input combination this state doesn't have an arrow for yet (or "always").
    const n = fsm.inputs.length
    const taken = fsm.transitions.filter(t => t.from === from).map(t => t.when)
    const options = n ? Array.from({ length: 2 ** n }, (_, i) => i.toString(2).padStart(n, '0')) : ['']
    const when = options.find(o => !taken.some(t => [...t].every((c, i) => c === '-' || c === o[i]))) ?? options[0]
    const t: FsmTransition = { id: newId('t'), from, to, when, out: Object.fromEntries(fsm.outputs.map(o => [o, 0 as Bit])) }
    set({ transitions: [...fsm.transitions, t] })
    setSelected({ kind: 'arrow', id: t.id })
  }

  function remove() {
    if (!selected) return
    if (selected.kind === 'arrow') set({ transitions: fsm.transitions.filter(t => t.id !== selected.id) })
    else set({ states: fsm.states.filter(s => s.id !== selected.id), transitions: fsm.transitions.filter(t => t.from !== selected.id && t.to !== selected.id), start: fsm.start === selected.id ? '' : fsm.start })
    setSelected(null)
  }

  function setNames(which: 'inputs' | 'outputs', text: string) {
    const names = [...new Set(text.toUpperCase().split(/[\s,;]+/).filter(validName))].slice(0, 4)
    if (which === 'inputs') {
      // Arrows keep what they said about inputs that are still there.
      const old = fsm.inputs
      set({ inputs: names, transitions: fsm.transitions.map(t => ({ ...t, when: names.map(n => (old.includes(n) ? t.when[old.indexOf(n)] ?? '-' : '-')).join('') })) })
    } else set({ outputs: names })
  }

  /** An arrow's label: its condition, and for a Mealy machine its outputs. */
  const label = (t: FsmTransition) => {
    const cond = fsm.inputs.length === 1 ? (t.when[0] === '-' || !t.when ? '–' : t.when) : showWhen(t.when, fsm.inputs).replace(/=/g, '').replace('always', '–')
    return fsm.kind === 'mealy' && fsm.outputs.length ? `${cond}/${fsm.outputs.map(o => t.out[o] ?? 0).join('')}` : cond
  }

  /** The path of an arrow: a loop above the state, or a curve (bowed when there's one back too). */
  const path = (t: FsmTransition) => {
    const a = byId(t.from), b = byId(t.to)
    if (!a || !b) return null
    if (a.id === b.id) {
      const d = `M${a.x - 14},${a.y - R + 4} C${a.x - 50},${a.y - R - 60} ${a.x + 50},${a.y - R - 60} ${a.x + 14},${a.y - R + 4}`
      return { d, lx: a.x, ly: a.y - R - 50 }
    }
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
    const ux = dx / len, uy = dy / len
    const back = fsm.transitions.some(o => o.from === t.to && o.to === t.from)
    // A state in the way: bow out round it (further for longer arrows).
    const blocked = fsm.states.some(o => {
      if (o.id === a.id || o.id === b.id) return false
      const along = (o.x - a.x) * ux + (o.y - a.y) * uy
      return along > 0 && along < len && Math.abs((o.x - a.x) * uy - (o.y - a.y) * ux) < R + 14
    })
    const bend = blocked ? Math.max(55, len / 5) : back ? 30 : 0
    const sx = a.x + ux * R, sy = a.y + uy * R, ex = b.x - ux * (R + 4), ey = b.y - uy * (R + 4)
    const mx = (sx + ex) / 2 - uy * bend * 1.6, my = (sy + ey) / 2 + ux * bend * 1.6
    return { d: `M${sx},${sy} Q${mx},${my} ${ex},${ey}`, lx: (sx + ex) / 2 - uy * bend - uy * 12, ly: (sy + ey) / 2 + ux * bend + ux * 12 + 4 }
  }

  const sel = selected?.kind === 'state' ? byId(selected.id) : null
  const arrow = selected?.kind === 'arrow' ? fsm.transitions.find(t => t.id === selected.id) : null

  return <div className="fsm">
    <div className="fsm-bar">
      <div className="logic-view" role="tablist" aria-label="Kind">
        <button className={fsm.kind === 'moore' ? 'on' : ''} onClick={() => set({ kind: 'moore' })} title="Outputs depend on the state only (written in each state)">Moore</button>
        <button className={fsm.kind === 'mealy' ? 'on' : ''} onClick={() => set({ kind: 'mealy' })} title="Outputs depend on the state and the inputs (written on each arrow)">Mealy</button>
      </div>
      <label>Inputs <input key={`i${fsm.inputs.join()}`} defaultValue={fsm.inputs.join(', ')} onBlur={e => setNames('inputs', e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} placeholder="X" /></label>
      <label>Outputs <input key={`o${fsm.outputs.join()}`} defaultValue={fsm.outputs.join(', ')} onBlur={e => setNames('outputs', e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} placeholder="Z" /></label>
      <button className="ghost" onClick={() => addState({ x: 120 + (fsm.states.length % 4) * 170, y: 140 + Math.floor(fsm.states.length / 4) * 150 })}><Plus size={14} /> State</button>
      <span className="grow" />
      <button className="ghost" onClick={() => { if (window.confirm('Start over with an empty diagram?')) { onChange({ ...fsm, states: [], transitions: [], start: '' }); setSelected(null) } }}>Clear</button>
    </div>
    <div className="fsm-main">
      <div className="fsm-canvas">
        <svg ref={svg} width={1200} height={800}
          onPointerMove={e => {
            const p = point(e)
            if (linking) setMouse(p)
            const d = drag.current
            if (d) setState(d.id, { x: Math.round(p.x - d.dx), y: Math.round(p.y - d.dy) })
          }}
          onPointerUp={() => { drag.current = null }}
          onPointerDown={() => { setSelected(null); setLinking(null) }}
          onDoubleClick={e => { if (e.target === svg.current) addState(point(e)) }}>
          <defs><marker id="fsm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="fsm-head" /></marker></defs>
          {fsm.transitions.map(t => {
            const p = path(t)
            if (!p) return null
            const on = arrow?.id === t.id
            return <g key={t.id} className={`fsm-arrow${on ? ' on' : ''}`} onPointerDown={e => { e.stopPropagation(); setSelected({ kind: 'arrow', id: t.id }) }}>
              <path d={p.d} className="fsm-arrow-hit" />
              <path d={p.d} className="fsm-arrow-line" markerEnd="url(#fsm-arrow)" />
              <text x={p.lx} y={p.ly} textAnchor="middle" className="fsm-arrow-label">{label(t)}</text>
            </g>
          })}
          {start && byId(start) && <path d={`M${byId(start)!.x - R - 36},${byId(start)!.y} L${byId(start)!.x - R - 4},${byId(start)!.y}`} className="fsm-arrow-line" markerEnd="url(#fsm-arrow)" />}
          {fsm.states.map(s => {
            const on = sel?.id === s.id
            return <g key={s.id} className={`fsm-state${on ? ' on' : ''}${linking ? ' target' : ''}`}
              onPointerDown={e => {
                e.stopPropagation()
                if (linking) { link(s.id); return }
                const p = point(e)
                drag.current = { id: s.id, dx: p.x - s.x, dy: p.y - s.y }
                setSelected({ kind: 'state', id: s.id })
              }}>
              <circle cx={s.x} cy={s.y} r={R} className="fsm-circle" />
              {s.id === start && <circle cx={s.x} cy={s.y} r={R - 5} className="fsm-circle inner" />}
              <text x={s.x} y={fsm.kind === 'moore' && fsm.outputs.length ? s.y - 2 : s.y + 5} textAnchor="middle" className="fsm-name">{s.name}</text>
              {fsm.kind === 'moore' && fsm.outputs.length > 0 && <text x={s.x} y={s.y + 15} textAnchor="middle" className="fsm-out">{fsm.outputs.map(o => s.out[o] ?? 0).join('')}</text>}
              {on && !linking && <g className="fsm-link" onPointerDown={e => { e.stopPropagation(); setLinking(s.id); setMouse(point(e)) }}>
                <circle cx={s.x + R + 12} cy={s.y} r={11} /><path d={`M${s.x + R + 6},${s.y} h12 m-4,-4 l4,4 l-4,4`} />
                <title>Draw an arrow: click here, then the state it goes to (the same state for a loop)</title>
              </g>}
            </g>
          })}
          {linking && byId(linking) && <path d={`M${byId(linking)!.x},${byId(linking)!.y} L${mouse.x},${mouse.y}`} className="fsm-arrow-line pending" />}
        </svg>
        {!fsm.states.length && <p className="fsm-hint">Double-click to add a state.</p>}
        {linking && <p className="fsm-hint">Now click the state the arrow goes to (Esc or click empty space to stop).</p>}
      </div>
      <aside className="fsm-side">
        {sel && <section className="fsm-edit">
          <h4>State {sel.name}</h4>
          <label>Name <input value={sel.name} maxLength={12} onChange={e => setState(sel.id, { name: e.target.value })} /></label>
          {fsm.kind === 'moore' && fsm.outputs.map(o => <label key={o} className="fsm-bit">{o} = <button onClick={() => setState(sel.id, { out: { ...sel.out, [o]: sel.out[o] ? 0 : 1 } })}>{sel.out[o] ?? 0}</button></label>)}
          <div className="actions">
            <button className="ghost" onClick={() => setLinking(sel.id)}><ArrowRight size={13} /> Arrow from here</button>
            {sel.id !== start && <button className="ghost" onClick={() => set({ start: sel.id })}>Make it the start</button>}
            <button className="ghost" onClick={remove}><Trash2 size={13} /></button>
          </div>
        </section>}
        {arrow && <section className="fsm-edit">
          <h4>{byId(arrow.from)?.name} → {byId(arrow.to)?.name}</h4>
          {fsm.inputs.length > 0 && <label>When <input key={`${arrow.id}${arrow.when}`} defaultValue={fsm.inputs.length === 1 ? arrow.when : showWhen(arrow.when, fsm.inputs)} placeholder={fsm.inputs.length === 1 ? '1, 0 or -' : 'X=1, Y=0'}
            onBlur={e => { const w = readWhen(e.target.value, fsm.inputs); if (w !== null) setArrow(arrow.id, { when: w }) }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} /></label>}
          <label>Goes to <select value={arrow.to} onChange={e => setArrow(arrow.id, { to: e.target.value })}>{fsm.states.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          {fsm.kind === 'mealy' && fsm.outputs.map(o => <label key={o} className="fsm-bit">{o} = <button onClick={() => setArrow(arrow.id, { out: { ...arrow.out, [o]: arrow.out[o] ? 0 : 1 } })}>{arrow.out[o] ?? 0}</button></label>)}
          <div className="actions"><button className="ghost" onClick={remove}><Trash2 size={13} /> Delete arrow</button></div>
        </section>}
        {!sel && !arrow && <p className="hint">Double-click empty space for a state. Click a state, then the arrow button beside it, then the state it goes to. Click an arrow to set when it’s taken{fsm.kind === 'mealy' ? ' and its outputs' : ''}.</p>}
        {analysis && fsm.states.length > 0 && <>
          {analysis.warnings.length > 0 && <ul className="logic-warnings">{analysis.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
          <h4>State table</h4>
          <div className="logic-table-wrap"><table className="logic-table fsm-table">
            <thead><tr><th>State</th><th>{analysis.bits.join('')}</th>{fsm.inputs.map(i => <th key={i}>{i}</th>)}<th>Next</th><th>{analysis.bits.map(b => `D${b.slice(1)}`).join('')}</th>{fsm.outputs.map(o => <th key={o} className="out">{o}</th>)}</tr></thead>
            <tbody>{analysis.rows.map((r, i) => <tr key={i}>
              <td>{r.state}</td><td>{r.code.toString(2).padStart(analysis.bits.length, '0')}</td>{r.input.map((b, j) => <td key={j}>{b}</td>)}
              <td>{r.next}</td><td>{r.nextCode.toString(2).padStart(analysis.bits.length, '0')}</td>{fsm.outputs.map(o => <td key={o} className="out">{r.out[o]}</td>)}
            </tr>)}</tbody>
          </table></div>
          <h4>Equations</h4>
          <div className="logic-exprs">{analysis.equations.map(e => <div key={e.name}><strong>{e.name}</strong> = {e.expr}</div>)}</div>
          <p className="hint">{analysis.flipFlops} D flip-flop{analysis.flipFlops === 1 ? '' : 's'} ({Math.ceil(analysis.flipFlops / 2)} × 7474), the start state is {analysis.bits.map(() => '0').join('')}. In the circuit, CLK steps it and turning RST off for a moment goes back to the start.</p>
          <button onClick={() => onBuild(fsm)}><Wand2 size={13} /> Build the circuit</button>
        </>}
      </aside>
    </div>
  </div>
}
