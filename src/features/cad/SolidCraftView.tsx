import { useEffect, useRef, useState, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Box, Download, ExternalLink, FolderOpen, Loader2, RotateCw } from 'lucide-react'
import { browserGo, isTauri, openExternal, openPath, solidcraftInstall, solidcraftServe, solidcraftStatus, type SolidCraftStatus } from '../../lib/bridge'
import { useOverlayOpen } from '../../core/shortcuts'
import { useTabContext } from '../../core/tabContext'
import { errorText } from '../../core/util'
import { usePagePlacement } from '../browser/placement'

// SolidCraft has its own page, apart from the Browser's (src-tauri/src/browser.rs), kept awake while hidden.
const PAGE = 'solidcraft'
/** The page is pointed at SolidCraft once; after that it stays on the design being worked on. */
let pageStarted = false

/** SolidCraft's address: WebGL2 where this web view has no WebGPU (SolidCraft's default). */
export function startAddress(base: string, webGpu: boolean): string {
  return webGpu ? base : `${base}?webgl`
}

type Exported = { name: string; path: string; state: 'started' | 'done' | 'failed' }

/** SolidCraft (open-source, laid out like Fusion 360) in the CAD tab: downloaded once, then served
 *  from this computer and shown in a page of its own. Exports go to Downloads. */
export function SolidCraftView({ show, switcher }: { show: boolean; switcher: ReactNode }) {
  const overlay = useOverlayOpen()
  const area = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<SolidCraftStatus | null>(null)
  const [address, setAddress] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [exported, setExported] = useState<Exported | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    void solidcraftStatus().then(setStatus).catch(e => setError(errorText(e, 'Couldn’t check SolidCraft')))
  }, [])
  useEffect(() => {
    if (!status?.installed || address) return
    void solidcraftServe().then(setAddress).catch(e => setError(errorText(e, 'Couldn’t start SolidCraft')))
  }, [status, address])
  useEffect(() => {
    if (!isTauri()) return
    const stops = [
      listen<{ done: number; total: number }>('solidcraft-progress', e => setProgress(e.payload)),
      listen<{ tab: string; path: string | null; state: Exported['state'] }>('browser-download', e => {
        if (e.payload.tab !== PAGE || !e.payload.path) return
        setExported({ name: e.payload.path.split(/[\\/]/).pop() ?? e.payload.path, path: e.payload.path, state: e.payload.state })
      }),
    ]
    return () => stops.forEach(p => void p.then(fn => fn()).catch(() => undefined))
  }, [])

  usePagePlacement(PAGE, show && !overlay && !!address, area, () => {
    if (pageStarted || !address) return null
    pageStarted = true
    return startAddress(address, typeof navigator !== 'undefined' && 'gpu' in navigator)
  }, setError, [address])

  useTabContext('cad', () => ({ title: 'SolidCraft (CAD)', text: 'The person is designing in SolidCraft, an open-source parametric CAD app laid out like Fusion 360 (Design workspace; Model, Surface, Assemble, Sheet Metal ribbons; a browser tree; a history timeline). Help with how to model things there, in Fusion-style steps: sketch on a plane, constrain and dimension, then extrude, revolve, fillet and so on.' }))

  async function install() {
    setError(''); setProgress({ done: 0, total: 0 })
    try { await solidcraftInstall(); setStatus(await solidcraftStatus()) } catch (e) { setError(errorText(e, 'Couldn’t download SolidCraft')) } finally { setProgress(null) }
  }

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`
  return <div className="cad-page">
    <div className="cad-bar">
      <Box size={16} />
      {switcher}
      <span className="grow" />
      {exported && <span className="cad-status">{exported.state === 'started' ? <><Loader2 size={13} className="spin" /> Exporting {exported.name}…</> : exported.state === 'done' ? <>Exported {exported.name} to Downloads</> : <>Couldn’t save {exported.name}</>}</span>}
      {exported?.state === 'done' && <button className="ghost" title="Show the Downloads folder" onClick={() => void openPath(exported.path.replace(/[\\/][^\\/]*$/, ''))}><FolderOpen size={14} /></button>}
      {address && <>
        <button className="ghost" title="Reload SolidCraft (it offers to recover unsaved work)" onClick={() => void browserGo(PAGE, 'reload')}><RotateCw size={14} /></button>
        <button className="ghost" title="Open SolidCraft in your own browser (designs saved there are kept apart from these)" onClick={() => void openExternal(address)}><ExternalLink size={14} /> My browser</button>
      </>}
    </div>
    {error && <p className="cal-error">{error}</p>}
    {!isTauri() ? <div className="solidcraft-intro"><p className="hint">SolidCraft opens here in the BridgeDeck app.</p></div>
      : status && !status.installed ? <div className="solidcraft-intro">
        <h2>SolidCraft: CAD laid out like Fusion 360</h2>
        <p>Open-source parametric CAD that works the way Fusion does: a Design workspace with a ribbon, a browser tree, a view cube and a history timeline you can roll back and edit.</p>
        <ul>
          <li>Sketches with constraints and dimensions driven by parameters</li>
          <li>Extrude, revolve, sweep, loft, fillet, chamfer, shell, draft, holes, threads, patterns, mirror, split and combine</li>
          <li>Assemblies with joints and motion, sheet metal, plastic enclosures</li>
          <li>Opens and exports STEP, IGES, STL, 3MF, OBJ and glTF</li>
        </ul>
        <p className="hint">It’s downloaded once ({status.downloadMb} MB, version {status.version}) and then works offline. Designs you save stay in SolidCraft (File ▸ Open); exports go to your Downloads folder.</p>
        <div className="actions">
          <button className="primary" disabled={!!progress} onClick={() => void install()}>{progress ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {progress ? (progress.total ? `Downloading… ${mb(progress.done)} of ${mb(progress.total)}` : 'Downloading…') : 'Download SolidCraft'}</button>
        </div>
        {progress && progress.total > 0 && <div className="solidcraft-progress"><i style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }} /></div>}
      </div>
        : !address && !error ? <div className="solidcraft-intro"><p className="hint"><Loader2 size={13} className="spin" /> Starting SolidCraft…</p></div> : null}
    <div ref={area} className="browser-area solidcraft-area" hidden={!address} />
  </div>
}
