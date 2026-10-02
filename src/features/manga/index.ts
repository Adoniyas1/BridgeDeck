import { Library } from 'lucide-react'
import type { FeatureManifest } from '../features'
import MangaPage from './MangaPage'
import ReaderTab from './ReaderTab'

/** Comics, manga and webtoons from your own files, on both computers (src-tauri/src/manga.rs). */
export const manga: FeatureManifest = { id: 'manga', title: 'Manga', icon: Library, Page: MangaPage, tabKinds: { 'manga-reader': ReaderTab } }
