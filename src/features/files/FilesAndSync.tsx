import FilesPage from './FilesPage'
import SyncPage from '../sync/SyncPage'

/** The Files tab: sending files at the top, the folders kept in sync with your computers below. */
export default function FilesAndSync({ active }: { active: boolean }) {
  return <>
    <FilesPage />
    <h2 className="page-section">Synced folders</h2>
    <SyncPage active={active} />
  </>
}
