import { lazy } from 'react'
import { Files } from 'lucide-react'
import type { FeatureManifest } from '../features'
import FilesSettings from './FilesSettings'
import { FilesBackground } from './state'
const FilesPage = lazy(() => import('./FilesPage'))

export const files: FeatureManifest = { id: 'files', title: 'Files', icon: Files, Page: FilesPage, Background: FilesBackground, Settings: FilesSettings, settingsOrder: 30 }
