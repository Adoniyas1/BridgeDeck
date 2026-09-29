import { Files } from 'lucide-react'
import type { FeatureManifest } from '../features'
import FilesPage from './FilesPage'
import FilesSettings from './FilesSettings'
import { FilesBackground } from './state'

export const files: FeatureManifest = { id: 'files', title: 'Files', icon: Files, Page: FilesPage, Background: FilesBackground, Settings: FilesSettings, settingsOrder: 30 }
