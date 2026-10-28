import { useEffect, useMemo, useRef, useState } from 'react'
import { Calculator, Delete, Trash2 } from 'lucide-react'
import { tabMenuStore } from '../core/shortcuts'
import { calculate, literal, readState, remember, show, type CalcState } from './calculator'

const KEY = 'bridgedeck.calculator'
const load = () => { try { return readState(localStorage.getItem(KEY)) } catch { return readState(null) } }
const keep = (s: CalcState) => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* this run only */ } }

/** The keypad: what each key types (`label` when it types itself). */
const KEYS: Array<{ label: string; text?: string; kind?: 'fn' | 'op' | 'eq' | 'del' | 'clear'; title?: string }> = [
  { label: 'sin', text: 'sin(', kind: 'fn' }, { label: 'cos', text: 'cos(', kind: 'fn' }, { label: 'tan', text: 'tan(', kind: 'fn' }, { label: 'ln', text: 'ln(', kind: 'fn' }, { label: 'log', text: 'log(', kind: 'fn', title: 'Base 10' },
  { label: '√', text: 'sqrt(', kind: 'fn' }, { label: 'x²', text: '^2', kind: 'fn' }, { label: 'xʸ', text: '^', kind: 'fn' }, { label: 'π', text: 'pi', kind: 'fn' }, { label: 'j', kind: 'fn', title: 'Imaginary unit' },
  { label: '(', kind: 'op' }, { label: ')', kind: 'op' }, { label: '∥', text: ' || ', kind: 'op', title: 'In parallel: a·b/(a+b)' }, { label: 'ans', kind: 'fn', title: 'The last answer' }, { label: '⌫', kind: 'del', title: 'Delete' },
  { label: '7' }, { label: '8' }, { label: '9' }, { label: '÷', text: '/', kind: 'op' }, { label: 'C', kind: 'clear', title: 'Clear the line' },
  { label: '4' }, { label: '5' }, { label: '6' }, { label: '×', text: '*', kind: 'op' }, { label: 'k', kind: 'fn', title: 'Kilo (×1000); also m, u, n, p, M, G' },
  { label: '1' }, { label: '2' }, { label: '3' }, { label: '−', text: '-', kind: 'op' }, { label: 'm', kind: 'fn', title: 'Milli (×0.001)' },
  { label: '0' }, { label: '.' }, { label: 'E', text: 'e', kind: 'fn', title: 'Times ten to the power: 3e8' }, { label: '+', kind: 'op' }, { label: '=', kind: 'eq' },
]

/** A calculator one click from anywhere, beside the checklist: type or tap a line, Enter works it
 *  out. Units, SI prefixes, complex numbers and ∥ as in a note's calculator block (lib/expr.ts);
 *  "R = 4.7k" keeps a name and "ans" is the last answer. The history is kept on this computer. */
export function CalculatorPopup() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<CalcState>(load)
  const [line, setLine] = useState('')
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => keep(state), [state])
  // Web pages sit above BridgeDeck's own window contents: they step aside while the popup is open.
  useEffect(() => { tabMenuStore.set(open); return () => tabMenuStore.set(false) }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  }, [open])
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight }, [state.history.length, open])

  // The answer so far, as the line is typed (nothing while it's unfinished).
  const preview = useMemo(() => {
    if (!line.trim()) return ''
    try { return show(calculate(line, state.vars, state.degrees).value) } catch { return '' }
  }, [line, state.vars, state.degrees])

  function work() {
    if (!line.trim()) return
    try {
      const { value, name } = calculate(line, state.vars, state.degrees)
      setState(s => remember(s, line, value, name))
      setLine('')
      setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /** Types at the cursor (a key on the keypad), keeping the focus in the line. */
  function type(text: string) {
    const el = input.current
    const start = el?.selectionStart ?? line.length, end = el?.selectionEnd ?? line.length
    // An operator first on an empty line works on the last answer, as on a pocket calculator.
    const lead = !line && /^\s*(\|\||[*/^+]|\^2)/.test(text) && state.history.length ? 'ans' : ''
    const next = line.slice(0, start) + lead + text + line.slice(end)
    setLine(next); setError('')
    const at = start + lead.length + text.length
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at, at) })
  }
  function press(k: (typeof KEYS)[number]) {
    if (k.kind === 'eq') return work()
    if (k.kind === 'clear') { setLine(''); setError(''); input.current?.focus(); return }
    if (k.kind === 'del') {
      const el = input.current
      const start = el?.selectionStart ?? line.length, end = el?.selectionEnd ?? line.length
      const from = start === end ? Math.max(0, start - 1) : start
      setLine(line.slice(0, from) + line.slice(end))
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(from, from) })
      return
    }
    type(k.text ?? k.label)
  }

  return <div className="quick-checklist quick-calc" ref={box}>
    <button className={open ? 'icon-button active' : 'icon-button'} onClick={() => { setOpen(o => !o); requestAnimationFrame(() => input.current?.focus()) }} title={open ? undefined : 'Calculator'} aria-label="Calculator" aria-expanded={open}>
      <Calculator size={15} />
    </button>
    {open && <div className="quick-checklist__popup quick-calc__popup" role="dialog" aria-label="Calculator">
      <header>
        <strong>Calculator</strong>
        <span className="grow" />
        <div className="quick-calc__mode" role="radiogroup" aria-label="Angles">
          <button role="radio" aria-checked={state.degrees} className={state.degrees ? 'on' : ''} onClick={() => setState(s => ({ ...s, degrees: true }))} title="sin(30) is 0.5">Deg</button>
          <button role="radio" aria-checked={!state.degrees} className={!state.degrees ? 'on' : ''} onClick={() => setState(s => ({ ...s, degrees: false }))} title="sin(pi/6) is 0.5">Rad</button>
        </div>
        <button className="icon-button" disabled={!state.history.length} onClick={() => setState(s => ({ ...s, history: [], vars: {} }))} title="Clear the history and the names you set" aria-label="Clear the history"><Trash2 size={14} /></button>
      </header>
      <ol ref={list} className="quick-calc__history">
        {state.history.map((h, i) => <li key={i}>
          <button className="quick-calc__expr" title="Use this line again" onClick={() => { setLine(h.expr); requestAnimationFrame(() => input.current?.focus()) }}>{h.expr}</button>
          <button className="quick-calc__result" title="Put this answer in the line" onClick={() => type(h.name ?? (h.value && literal(h.value)) ?? h.result)}>{h.name ? `${h.name} = ` : '= '}{h.result}</button>
        </li>)}
        {!state.history.length && <li className="empty">Type a sum and press Enter: 2(3+4), sin(30), 12V / 2.2kΩ, 4.7k ∥ 10k, R = 4.7k…</li>}
      </ol>
      <form onSubmit={e => { e.preventDefault(); work() }}>
        <input ref={input} value={line} onChange={e => { setLine(e.target.value); setError('') }} placeholder="2 * (3 + 4)" spellCheck={false} autoComplete="off" aria-label="Sum to work out"
          onKeyDown={e => { if (e.key === 'ArrowUp' && !line && state.history.length) { e.preventDefault(); setLine(state.history[state.history.length - 1].expr) } }} />
        <small className={error ? 'quick-calc__error' : 'quick-calc__preview'}>{error || (preview ? `= ${preview}` : ' ')}</small>
      </form>
      <div className="quick-calc__keys">
        {KEYS.map(k => <button key={k.label} type="button" className={k.kind ? `quick-calc__key ${k.kind}` : 'quick-calc__key'} title={k.title} onClick={() => press(k)}>{k.kind === 'del' ? <Delete size={14} /> : k.label}</button>)}
      </div>
    </div>}
  </div>
}
