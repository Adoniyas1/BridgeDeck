import { isTauri, projectsList, type ProjectList } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { createStore } from '../../core/store'

export const projectsStore = createStore<{ list: ProjectList | null; error: string }>({ list: null, error: '' })

/** Reads the project folders (in the synced folder, so projects made on the other computer appear). */
export async function refreshProjects() {
  if (!isTauri()) return
  try {
    projectsStore.set({ list: await projectsList(configStore.get().syncthing.sharedFolderPath), error: '' })
  } catch (e) {
    projectsStore.set(current => ({ ...current, error: String(e) }))
  }
}
