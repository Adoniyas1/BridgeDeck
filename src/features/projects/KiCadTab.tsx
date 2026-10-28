import { createElement, useEffect, useState } from 'react'
import { CircuitBoard, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { isTauri, openPath, projectKicad, type KicadFile } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { projectsStore, refreshProjects } from './state'
import { errorText } from '../../core/util'
import type { DynamicTab } from '../../core/tabs'

/** KiCanvas (public/vendor/kicanvas), loaded once, the first time a KiCad file is opened. */
let script: Promise<void> | null = null
function loadKiCanvas(): Promise<void> {
  script ??= new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.type = 'module'
    el.src = '/vendor/kicanvas/kicanvas.js'
    el.onload = () => resolve()
    el.onerror = () => { script = null; reject(new Error('The KiCad viewer couldn’t load')) }
    document.head.appendChild(el)
  })
  return script
}

/** A KiCad schematic or board from a project folder, drawn by KiCanvas: scroll to zoom, drag to
 *  move, click a part to see it. Schematics bring their other sheets along. Viewing only: editing
 *  is in KiCad (Open in KiCad). */
export function KiCadTab({ tab }: { tab: DynamicTab; active: boolean }) {
  const project = String(tab.params?.project ?? '')
  const path = String(tab.params?.path ?? '')
  const [files, setFiles] = useState<KicadFile[] | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [stamp, setStamp] = useState(0)
  const root = useStore(projectsStore).list?.root
  useEffect(() => { if (!root && isTauri()) void refreshProjects() }, [root])

  useEffect(() => { void loadKiCanvas().then(() => setReady(true)).catch(e => setError(errorText(e, 'The KiCad viewer couldn’t load'))) }, [])
  useEffect(() => {
    if (!isTauri()) { setError('KiCad files open in the BridgeDeck app.'); return }
    setFiles(null)
    void projectKicad(project, path).then(setFiles).catch(e => setError(errorText(e, 'Couldn’t read the file')))
  }, [project, path, stamp])

  async function openInKicad() {
    if (!root) return
    try { await openPath(`${root}/${project}/${path}`) } catch (e) { setError(errorText(e, 'Couldn’t open it')) }
  }

  const kind = path.endsWith('.kicad_pcb') ? 'Board' : 'Schematic'
  return <div className="kicad-tab">
    <div className="kicad-bar">
      <CircuitBoard size={15} />
      <strong>{path.split('/').pop()}</strong>
      <small>{kind}{files && files.length > 1 ? ` · ${files.length} sheets` : ''} · {project}</small>
      <span className="grow" />
      <small className="hint">Scroll to zoom, drag to move, click a part</small>
      <button className="ghost" title="Read the file again (after saving in KiCad)" onClick={() => setStamp(s => s + 1)}><RefreshCw size={14} /></button>
      <button className="ghost" disabled={!root} onClick={() => void openInKicad()}><FolderOpen size={14} /> Open in KiCad</button>
    </div>
    <div className="kicad-view">
      {error && <p className="error-text">{error}</p>}
      {!error && (!ready || !files) && <p className="hint"><Loader2 size={14} className="spin" /> Opening…</p>}
      {ready && files && createElement('kicanvas-embed', { key: stamp, controls: 'none', zoom: 'objects', class: 'kicad-embed' },
        ...files.map(f => createElement('kicanvas-source', { key: f.name, name: f.name }, f.text)))}
    </div>
  </div>
}
