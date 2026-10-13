import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, FolderOpen, History, Trash2, X } from 'lucide-react'
import type { CircuitFile } from '../../lib/bridge'
import { chipDef, pinFacing, pinPoint, placedPins, readCircuit, sizeOf, wirePath, type Circuit } from './model'
import { PartShape } from './Symbols'

/** A small picture of a circuit: its parts and wires, scaled to fit. */
export function CircuitPreview({ circuit, width = 320, height = 220 }: { circuit: Circuit; width?: number; height?: number }) {
  const box = useMemo(() => {
    if (!circuit.parts.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of circuit.parts) {
      const { w, h } = sizeOf(p)
      for (const pt of [{ x: 0, y: 0 }, { x: w, y: h }, ...placedPins(p)]) {
        x0 = Math.min(x0, p.x + pt.x); y0 = Math.min(y0, p.y + pt.y - 14); x1 = Math.max(x1, p.x + pt.x); y1 = Math.max(y1, p.y + pt.y + 14)
      }
    }
    const pad = 20
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
  }, [circuit])
  if (!box) return <div className="logic-preview empty" style={{ width, height }}>Empty circuit</div>
  const end = (ref: string) => {
    const part = circuit.parts.find(p => ref.startsWith(`${p.id}:`))
    if (!part) return null
    const pin = ref.slice(part.id.length + 1)
    const at = pinPoint(part, pin)
    if (!at) return null
    const f = part.kind === 'joint' ? { x: 1, y: 0 } : pinFacing(part, pin)
    return { ...at, fx: f.x, fy: f.y }
  }
  return <svg className="logic-preview" width={width} height={height} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet">
    {circuit.wires.map(w => {
      const a = end(w.a), b = end(w.b)
      return a && b ? <path key={w.id} d={wirePath(w, a, b)} className="logic-wire" style={{ stroke: '#7d8796' }} /> : null
    })}
    {circuit.parts.map(p => {
      const { w, h } = sizeOf(p)
      if (p.kind === 'joint') return <circle key={p.id} cx={p.x} cy={p.y} r={4} className="logic-preview-joint" />
      return <g key={p.id} transform={p.rot ? `rotate(${p.rot} ${p.x + w / 2} ${p.y + h / 2})` : undefined}><PartShape part={p} level={() => undefined} selected={false} /></g>
    })}
  </svg>
}

/** What's in a circuit, in a few words. */
export function circuitSummary(c: Circuit): string {
  const count = (n: number, one: string, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : '')
  const chips = c.parts.filter(p => p.kind === 'chip').map(p => chipDef(p.chip)?.part ?? '?')
  return [
    count(c.parts.filter(p => p.kind === 'switch' || p.kind === 'clock').length, 'input'),
    count(c.parts.filter(p => p.kind === 'gate').length, 'gate'),
    chips.length ? `${chips.length} chip${chips.length === 1 ? '' : 's'} (${[...new Set(chips)].join(', ')})` : '',
    count(c.parts.filter(p => p.kind === 'led' || p.kind === 'seg7').length, 'output'),
    count(c.wires.length, 'wire'),
  ].filter(Boolean).join(' · ') || 'Nothing in it yet'
}

const when = (ms: number) => {
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}
const ago = (ms: number) => {
  const min = Math.round((Date.now() - ms) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

type Item = { key: string; title: string; sub: string; load: () => Promise<string>; onOpen: () => void; onDelete?: () => void; current?: boolean }

/** Open or Versions: the list on the left, a preview of the one under the pointer on the right. */
export function CircuitMenu({ mode, files, versions, file, loadFile, loadVersion, onOpenFile, onOpenVersion, onDelete, onClose }: {
  mode: 'open' | 'versions'
  files: CircuitFile[]
  versions: number[]
  file: { project: string; name: string }
  loadFile: (f: CircuitFile) => Promise<string>
  loadVersion: (at: number) => Promise<string>
  onOpenFile: (f: CircuitFile) => void
  onOpenVersion: (at: number) => void
  onDelete: (f: CircuitFile) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, Circuit | 'error'>>({})

  useEffect(() => {
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.logic-menu-toggle')) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc) }
  }, [onClose])

  const items: Item[] = mode === 'open'
    ? files
      .filter(f => !query || `${f.name} ${f.project}`.toLowerCase().includes(query.toLowerCase()))
      .map(f => ({
        key: `${f.project}/${f.name}`, title: f.name, sub: `${f.project || 'No project'} · ${f.modified ? ago(f.modified) : ''}`,
        load: () => loadFile(f), onOpen: () => onOpenFile(f), onDelete: () => onDelete(f),
        current: f.project === file.project && f.name === file.name,
      }))
    : versions.map(at => ({ key: String(at), title: when(at), sub: `Replaced ${ago(at)}`, load: () => loadVersion(at), onOpen: () => onOpenVersion(at) }))

  const shown = items.find(i => i.key === hover) ?? items[0]
  // Each preview is read once, when its row is first pointed at (or is first in the list).
  const loading = useRef(new Set<string>())
  useEffect(() => {
    if (!shown || loading.current.has(shown.key)) return
    const key = shown.key
    loading.current.add(key)
    shown.load().then((text): Circuit | 'error' => readCircuit(text)).catch(() => 'error' as const).then(c => setPreviews(p => ({ ...p, [key]: c })))
  }, [shown])
  const preview = shown ? previews[shown.key] : undefined

  return <div className="logic-menu" ref={box} role="dialog" aria-label={mode === 'open' ? 'Open a circuit' : 'Earlier versions'}>
    <div className="logic-menu__list">
      <div className="logic-menu__head">
        {mode === 'open' ? <><FolderOpen size={14} /> Open a circuit</> : <><History size={14} /> Earlier versions of “{file.name}”</>}
        <button className="ghost" onClick={onClose} aria-label="Close"><X size={13} /></button>
      </div>
      {mode === 'open' && files.length > 6 && <input className="logic-menu__search" autoFocus placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} />}
      <div className="logic-menu__items">
        {items.length ? items.map(i => <div key={i.key} className={`logic-menu__item${shown?.key === i.key ? ' on' : ''}${i.current ? ' current' : ''}`} onPointerEnter={() => setHover(i.key)}>
          <button onClick={i.onOpen} onFocus={() => setHover(i.key)}>
            <span>{mode === 'versions' && <Clock3 size={12} />} {i.title}{i.current && <em>open now</em>}</span>
            <small>{i.sub}</small>
          </button>
          {i.onDelete && <button className="ghost logic-menu__delete" title="Delete" onClick={i.onDelete}><Trash2 size={12} /></button>}
        </div>)
          : <p className="hint">{mode === 'open' ? (query ? 'Nothing matches.' : 'No saved circuits yet. Save one to see it here.') : 'No earlier versions yet. Each save keeps the one it replaces.'}</p>}
      </div>
    </div>
    {shown && <div className="logic-menu__preview">
      {preview === 'error' ? <p className="hint">Couldn’t read this one.</p>
        : preview ? <><CircuitPreview circuit={preview} /><p className="logic-menu__summary">{circuitSummary(preview)}</p></>
          : <p className="hint">Loading the preview…</p>}
      <button onClick={shown.onOpen}>{mode === 'open' ? 'Open' : 'Open this version'}</button>
      {mode === 'versions' && <p className="hint">The circuit you have open now stays in Versions when you save over it.</p>}
    </div>}
  </div>
}
