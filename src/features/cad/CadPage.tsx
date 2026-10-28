import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Braces, ClipboardPaste, Download, FilePlus, FolderOpen, Loader2, Maximize, Save, Sparkles, Trash2 } from 'lucide-react'
import { cadDelete, cadExport, cadFiles, cadLoad, cadSave, isTauri, pickCadExport, type CadFile } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { useTabContext } from '../../core/tabContext'
import { askMimir } from '../mimir'
import { build, exportModel } from './kernel'
import type { MeshedPart } from './cad.worker'
import { Viewer } from './Viewer'
import { SolidCraftView } from './SolidCraftView'
import { cadPrompt, EXAMPLES, modelFromText, paramControls, paramLabel } from './model'

const DRAFT_KEY = 'bridgedeck.cad.draft'
const MODE_KEY = 'bridgedeck.cad.mode'
type Mode = 'solidcraft' | 'code'
const loadMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === 'code' ? 'code' : 'solidcraft' } catch { return 'solidcraft' } }

/** The CAD tab: SolidCraft (Fusion-style, the default) or a model written as a short script. */
export default function CadTab({ active }: { active: boolean }) {
  const [mode, setModeState] = useState<Mode>(loadMode)
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* convenience */ } }
  const switcher = <div className="spotify-modes cad-modes" role="tablist">
    <button role="tab" aria-selected={mode === 'solidcraft'} className={mode === 'solidcraft' ? 'on' : ''} onClick={() => setMode('solidcraft')} title="Full CAD laid out like Fusion 360: sketches, features, timeline, assemblies"><Box size={13} /> SolidCraft</button>
    <button role="tab" aria-selected={mode === 'code'} className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')} title="A part written as a short script with sliders, which Mimir can write for you"><Braces size={13} /> Code parts</button>
  </div>
  return mode === 'solidcraft' ? <SolidCraftView show={active} switcher={switcher} /> : <CodeCad switcher={switcher} />
}
type Draft = { name: string; code: string; params: Record<string, unknown> }
const readDraft = (): Draft => {
  try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null; if (d?.code) return d } catch { /* a fresh start */ }
  return { name: EXAMPLES[0].name, code: EXAMPLES[0].code, params: {} }
}

/** The diagonal of all the parts' bounding boxes together. */
const sizeOf = (parts: MeshedPart[]) => {
  if (!parts.length) return 0
  const lo = [0, 1, 2].map(i => Math.min(...parts.map(p => p.box[0][i])))
  const hi = [0, 1, 2].map(i => Math.max(...parts.map(p => p.box[1][i])))
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
}

/** Parametric CAD: a model is a short replicad script (OpenCascade, the kernel FreeCAD uses) whose
 *  parameters are sliders; it rebuilds as you type or drag, shows in 3D, and exports STL to print or
 *  STEP for other CAD programs. Models are saved in the shared folder's CAD folder. */
function CodeCad({ switcher }: { switcher: ReactNode }) {
  const [draft, setDraft] = useState<Draft>(readDraft)
  const [parts, setParts] = useState<MeshedPart[]>([])
  const [defaults, setDefaults] = useState<Record<string, unknown>>({})
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [fit, setFit] = useState(0)
  const [files, setFiles] = useState<CadFile[]>([])
  const [exporting, setExporting] = useState('')
  const [request, setRequest] = useState('')
  const firstBuild = useRef(true)
  /** The model's size when the camera last framed it: framed again when it grows or shrinks a lot. */
  const framedSize = useRef(0)
  const edit = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }))

  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) } catch { /* this run only */ } }, [draft])
  useEffect(() => { if (isTauri()) void cadFiles().then(setFiles).catch(() => undefined) }, [])

  // Rebuilt a moment after each change (typing, a slider); the camera frames the first build.
  const runId = useRef(0)
  useEffect(() => {
    const id = ++runId.current
    const timer = window.setTimeout(() => {
      setBuilding(true)
      void build(draft.code, draft.params).then(r => {
        if (id !== runId.current) return
        setParts(r.parts); setDefaults(r.defaults); setError('')
        setMessage(`Built in ${r.ms < 1000 ? `${r.ms} ms` : `${(r.ms / 1000).toFixed(1)} s`}`)
        const size = sizeOf(r.parts)
        if (firstBuild.current || size > framedSize.current * 1.35 || size < framedSize.current / 1.6) { firstBuild.current = false; framedSize.current = size; setFit(f => f + 1) }
      }).catch(e => { if (id === runId.current) { setError(errorText(e, 'Couldn’t build it')); setMessage('') } }).finally(() => { if (id === runId.current) setBuilding(false) })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [draft.code, draft.params])

  const controls = useMemo(() => paramControls(defaults), [defaults])
  const value = (key: string) => draft.params[key] ?? defaults[key]

  function load(name: string, code: string) {
    setDraft({ name, code, params: {} })
    firstBuild.current = true
  }
  async function open(f: CadFile) {
    try { load(f.name, await cadLoad(f.name)) } catch (e) { setError(errorText(e, 'Couldn’t open it')) }
  }
  async function save() {
    try { await cadSave(draft.name, draft.code); setFiles(await cadFiles()); setMessage(`Saved “${draft.name}” in the shared CAD folder.`) } catch (e) { setError(errorText(e, 'Couldn’t save it')) }
  }
  async function exportAs(kind: 'stl' | 'step') {
    setExporting(kind)
    try {
      const path = await pickCadExport(draft.name, kind)
      if (!path) return
      await cadExport(path, await exportModel(kind))
      setMessage(`Saved ${kind.toUpperCase()} to ${path}`)
    } catch (e) { setError(errorText(e, 'Couldn’t export it')) } finally { setExporting('') }
  }
  async function pasteModel() {
    try {
      const code = modelFromText(await navigator.clipboard.readText())
      if (code) { edit({ code, params: {} }); setMessage('Model pasted.') } else setError('No model on the clipboard: copy a reply with the model in a ```js block.')
    } catch (e) { setError(errorText(e, 'Couldn’t read the clipboard')) }
  }

  useTabContext('cad', () => ({ title: `CAD model “${draft.name}”`, text: [`The CAD model “${draft.name}” (replicad):\n\`\`\`js\n${draft.code}\n\`\`\``, Object.keys(draft.params).length ? `Slider values now: ${JSON.stringify(draft.params)}` : '', error ? `It doesn’t build: ${error}` : ''].filter(Boolean).join('\n\n') }))

  return <div className="cad-page">
    <div className="cad-bar">
      <Box size={16} />
      {switcher}
      <input className="cad-name" value={draft.name} onChange={e => edit({ name: e.target.value })} aria-label="Model name" />
      <select value="" onChange={e => { const ex = EXAMPLES.find(x => x.name === e.target.value); if (ex && (window.confirm(`Open the example “${ex.name}”? (Save first to keep this model.)`))) load(ex.name, ex.code) }} aria-label="Examples">
        <option value="">Examples…</option>
        {EXAMPLES.map(x => <option key={x.name} value={x.name} title={x.about}>{x.name}</option>)}
      </select>
      <details className="logic-open">
        <summary className="ghost"><FolderOpen size={14} /> Open</summary>
        <div className="logic-files">
          {files.length ? files.map(f => <div key={f.name} className="logic-file">
            <button onClick={e => { void open(f); (e.currentTarget.closest('details') as HTMLDetailsElement).open = false }}><span>{f.name}</span><small>{new Date(f.modified).toLocaleDateString()}</small></button>
            <button className="ghost" title="Delete" onClick={() => { if (window.confirm(`Delete ${f.name}?`)) void cadDelete(f.name).then(cadFiles).then(setFiles).catch(e => setError(errorText(e, 'Couldn’t delete'))) }}><Trash2 size={12} /></button>
          </div>) : <p className="hint">No saved models yet.</p>}
        </div>
      </details>
      <button className="ghost" disabled={!isTauri()} onClick={() => void save()} title="Save in the shared CAD folder (on both computers)"><Save size={14} /> Save</button>
      <button className="ghost" onClick={() => { if (window.confirm('Start a new model? (Save first to keep this one.)')) load('Untitled', 'const defaultParams = { size: 20 }\n\nfunction main({ makeBaseBox }, p) {\n  return makeBaseBox(p.size, p.size, p.size)\n}\n') }}><FilePlus size={14} /> New</button>
      <span className="grow" />
      <span className="cad-status">{building ? <><Loader2 size={13} className="spin" /> Building…</> : message}</span>
      <button className="ghost" onClick={() => { framedSize.current = sizeOf(parts); setFit(f => f + 1) }} title="Frame the model"><Maximize size={14} /></button>
      <button className="ghost" disabled={!isTauri() || !parts.length || !!exporting} onClick={() => void exportAs('stl')} title="For 3D printing (Cura, PrusaSlicer, Bambu Studio)"><Download size={14} /> {exporting === 'stl' ? 'Exporting…' : 'STL'}</button>
      <button className="ghost" disabled={!isTauri() || !parts.length || !!exporting} onClick={() => void exportAs('step')} title="Exact solids for other CAD programs (Fusion, SolidWorks, FreeCAD, Onshape)"><Download size={14} /> {exporting === 'step' ? 'Exporting…' : 'STEP'}</button>
    </div>
    <div className="cad-main">
      <div className="cad-side">
        {controls.length > 0 && <div className="cad-params">
          {controls.map(c => <label key={c.key} className="cad-param">
            <span>{paramLabel(c.key)}</span>
            {c.kind === 'boolean'
              ? <input type="checkbox" checked={!!value(c.key)} onChange={e => edit({ params: { ...draft.params, [c.key]: e.target.checked } })} />
              : <>
                <input type="range" min={c.min} max={c.max} step={c.step} value={Number(value(c.key))} onChange={e => edit({ params: { ...draft.params, [c.key]: Number(e.target.value) } })} />
                <input type="number" step={c.step} value={Number(value(c.key))} onChange={e => edit({ params: { ...draft.params, [c.key]: Number(e.target.value) } })} />
              </>}
          </label>)}
          {Object.keys(draft.params).length > 0 && <button className="ghost" onClick={() => edit({ params: {} })}>Back to the model’s values</button>}
        </div>}
        <textarea className="cad-code" spellCheck={false} value={draft.code} onChange={e => edit({ code: e.target.value })} aria-label="Model script"
          onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); const t = e.currentTarget; const at = t.selectionStart; edit({ code: `${draft.code.slice(0, at)}  ${draft.code.slice(t.selectionEnd)}` }); requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = at + 2 }) } }} />
        <form className="cad-ask" onSubmit={e => { e.preventDefault(); if (request.trim()) { void askMimir(cadPrompt(request.trim(), draft.code), true); setRequest('') } }}>
          <input value={request} onChange={e => setRequest(e.target.value)} placeholder="Ask Mimir: add a slot for a zip tie, make the walls 3 mm…" />
          <button className="ghost" disabled={!request.trim()} title="Mimir writes the changed model; copy its reply and press Paste"><Sparkles size={14} /></button>
          <button type="button" className="ghost" title="Paste a model (or Mimir's reply with one in a code block)" onClick={() => void pasteModel()}><ClipboardPaste size={14} /></button>
        </form>
      </div>
      <div className="cad-view">
        <Viewer parts={parts} fit={fit} />
        {error && <div className="cad-error">{error}</div>}
        {!parts.length && !error && <div className="cad-loading"><Loader2 size={16} className="spin" /> Loading the CAD kernel…</div>}
      </div>
    </div>
  </div>
}
