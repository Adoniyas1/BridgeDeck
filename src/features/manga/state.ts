import { convertFileSrc } from '@tauri-apps/api/core'
import { isTauri, mangaLibrary, type MangaLibrary } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { createStore } from '../../core/store'
import { openTab } from '../../core/tabs'

export const mangaStore = createStore<{ library: MangaLibrary | null; error: string }>({ library: null, error: '' })

export async function refreshManga() {
  if (!isTauri()) return
  try {
    mangaStore.set({ library: await mangaLibrary(configStore.get().syncthing.sharedFolderPath), error: '' })
  } catch (e) {
    mangaStore.set(s => ({ ...s, error: String(e) }))
  }
}

/** A page or a cover, served from the library by the `bdmanga` scheme (manga.rs). */
export const pageUrl = (series: string, chapter: string, page: number, version?: string) => {
  const url = convertFileSrc(`${series}/${chapter}/${page}`, 'bdmanga')
  // A version is supplied per reader opening. This prevents Chromium from retaining a
  // stale response when a streamed page is first cached under a different MIME type.
  return version ? `${url}?v=${encodeURIComponent(version)}` : url
}
export const coverUrl = (series: string, version = 0) => `${convertFileSrc(`${series}/.cover`, 'bdmanga')}?v=${version}`

/** Opens a chapter in its own tab. */
export function openChapter(series: string, title: string, chapter: string, page = 0) {
  openTab({ id: `manga:${series}`, kind: 'manga-reader', title, params: { series, chapter, page: String(page), at: String(Date.now()) } })
}
