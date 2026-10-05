import { convertFileSrc } from '@tauri-apps/api/core'
import { isTauri, mangaApplyDetails, mangaLibrary, mangaSearchDetails, type MangaLibrary } from '../../lib/bridge'
import { configStore } from '../../core/config'
import { createStore } from '../../core/store'
import { openTab } from '../../core/tabs'

export const mangaStore = createStore<{ library: MangaLibrary | null; error: string }>({ library: null, error: '' })

// The library may be refreshed periodically, but a missing metadata lookup should happen
// once per app load, not on every 15-second refresh.
const metadataChecked = new Set<string>()
const comparableTitle = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

async function fillMissingMetadata(library: MangaLibrary) {
  const incomplete = library.series.filter(series => {
    const title = series.meta.title?.trim()
    return Boolean(title) && (!series.meta.description || !series.meta.author || !series.hasCover) && !metadataChecked.has(series.name)
  }).slice(0, 4)
  if (!incomplete.length) return
  for (const series of incomplete) {
    metadataChecked.add(series.name)
    try {
      const title = series.meta.title?.trim() || series.name
      const results = await mangaSearchDetails(title)
      const normalized = comparableTitle(title)
      const match = results.find(result => comparableTitle(result.title ?? '') === normalized) ?? results[0]
      if (match) await mangaApplyDetails(series.name, match)
    } catch {
      // A source can be offline or absent from AniList. It will be tried again next app load.
    }
  }
  mangaStore.set({ library: await mangaLibrary(configStore.get().syncthing.sharedFolderPath), error: '' })
}

export async function refreshManga() {
  if (!isTauri()) return
  try {
    const library = await mangaLibrary(configStore.get().syncthing.sharedFolderPath)
    mangaStore.set({ library, error: '' })
    void fillMissingMetadata(library)
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
/** Catalog covers are loaded by the native client because some source CDNs reject webview hotlinks. */
export const catalogCoverUrl = (source: string) => {
  const encoded = btoa(source).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return convertFileSrc(`catalog/${encoded}`, 'bdmanga')
}

/** Opens a chapter in its own tab. */
export function openChapter(series: string, title: string, chapter: string, page = 0) {
  openTab({ id: `manga:${series}`, kind: 'manga-reader', title, params: { series, chapter, page: String(page), at: String(Date.now()) } })
}
