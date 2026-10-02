import { isTauri, studyLibrary, type StudyLibrary } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { createStore } from '../../core/store'

export const libraryStore = createStore<{ library: StudyLibrary | null; error: string }>({ library: null, error: '' })

/** Reads the course folders (in the synced folder, so books added on the other computer appear). */
export async function refreshLibrary() {
  if (!isTauri()) return
  try {
    libraryStore.set({ library: await studyLibrary(configStore.get().syncthing.sharedFolderPath), error: '' })
  } catch (e) {
    libraryStore.set(current => ({ ...current, error: String(e) }))
  }
}
