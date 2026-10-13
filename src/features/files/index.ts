import { lazy } from 'react'
import { Files } from 'lucide-react'
import type { FeatureManifest } from '../features'
import FilesSettings from './FilesSettings'
import { FilesBackground } from './state'
// Sending files and the synced folders, on one page.
const FilesPage = lazy(() => import('./FilesAndSync'))

export const files: FeatureManifest = { id: 'files', title: 'Files', icon: Files, Page: FilesPage, Background: FilesBackground, Settings: FilesSettings, settingsOrder: 30 }
