import { useRef, useState } from 'react'
import { Excalidraw, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { drawingSave } from '../../lib/bridge'

// Excalidraw's fonts come with BridgeDeck (vite.config.ts), not from a CDN.
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/'

type Api = { getSceneElements: () => readonly unknown[]; getAppState: () => Record<string, unknown>; getFiles: () => Record<string, unknown> }

/** Excalidraw over the whole window, for one drawing; Save writes the scene and its picture. */
export default function DrawingEditor({ id, scene, onClose }: { id: string; scene: string | null; onClose: (saved: { scene: string; svg: string } | null) => void }) {
  const api = useRef<Api | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const initial = (() => { try { return scene ? JSON.parse(scene) : null } catch { return null } })()

  async function save() {
    const a = api.current
    if (!a) return
    setBusy(true); setError('')
    try {
      const elements = a.getSceneElements(), appState = a.getAppState(), files = a.getFiles()
      const json = serializeAsJSON(elements as never, appState as never, files as never, 'local')
      const picture = await exportToSvg({ elements: elements as never, appState: { ...appState, exportBackground: true, exportWithDarkMode: false } as never, files: files as never })
      const svg = picture.outerHTML
      await drawingSave(id, json, svg)
      onClose({ scene: json, svg })
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }

  return <div className="drawing-editor">
    <div className="drawing-editor-bar">
      <strong>Drawing</strong><span className="grow" />
      {error && <span className="error-text">{error}</span>}
      <button className="secondary" onClick={() => onClose(null)}>Close without saving</button>
      <button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
    <div className="drawing-editor-canvas">
      <Excalidraw excalidrawAPI={a => { api.current = a as unknown as Api }} initialData={initial ? { elements: initial.elements, appState: { ...initial.appState, collaborators: new Map() }, files: initial.files } : null} theme="dark" />
    </div>
  </div>
}
