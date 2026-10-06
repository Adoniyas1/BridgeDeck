import { FolderOpen, NotebookPen } from 'lucide-react'
import { useEffect, useState, lazy } from 'react'
import { isTauri, openPath, pickTransferPaths, vaultSettings, type VaultStatus } from '../../lib/bridge'
import { Card, SectionTitle, Toggle } from '../../ui'
import type { FeatureManifest } from '../features'
import { NotesBackground, overdueStore } from './state'
const NotesPage = lazy(() => import('./NotesPage'))

/** The vault: notes as Markdown files that Obsidian, Logseq or Zettlr can open. */
function NotesSettings() {
  const [vault, setVault] = useState<VaultStatus | null>(null)
  const [error, setError] = useState('')
  const update = (enabled?: boolean, path?: string) => void vaultSettings(enabled, path).then(setVault).catch(e => setError(String(e)))
  useEffect(() => {
    if (!isTauri()) return
    update()
    const timer = window.setInterval(() => update(), 5000)
    return () => window.clearInterval(timer)
  }, [])
  async function choose() {
    const [picked] = await pickTransferPaths(true)
    if (picked) update(undefined, picked)
  }
  return <Card><SectionTitle title="Notes" subtitle="Your notes as Markdown files too: open the folder in Obsidian, Logseq or Zettlr" />
    <Toggle checked={!!vault?.enabled} onChange={on => update(on)} label="Keep notes as Markdown files on this computer (a vault)" />
    {vault?.enabled && <>
      <p className="hint">Folder: <strong>{vault.path || '—'}</strong> · {vault.files} note{vault.files === 1 ? '' : 's'}</p>
      <div className="actions">
        <button className="secondary" onClick={() => void choose()}><FolderOpen size={15} />Choose folder</button>
        <button className="secondary" disabled={!vault.path} onClick={() => void openPath(vault.path)}><FolderOpen size={15} />Open folder</button>
      </div>
      {(vault.error || error) && <p className="notes-error">{vault.error || error}</p>}
      <p className="hint">Edits made in another app come back into BridgeDeck within a few seconds and reach your other computer as usual; renaming or moving a file renames the note or changes its folder. Each computer keeps its own copy of the folder, so don’t also share it with Sync.</p>
    </>}
  </Card>
}

/** Notes and checklists, kept on every paired computer (src-tauri/src/bridgelink/notes.rs). */
export const notes: FeatureManifest = { id: 'notes', title: 'Notes', icon: NotebookPen, Page: NotesPage, Background: NotesBackground, badge: overdueStore, Settings: NotesSettings, settingsOrder: 38 }
