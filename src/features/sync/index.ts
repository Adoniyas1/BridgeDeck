import { lazy } from 'react'
import { FolderSync } from 'lucide-react'
import type { FeatureManifest } from '../features'
import SyncSettings from './SyncSettings'
import { SyncBackground } from './state'
const SyncPage = lazy(() => import('./SyncPage'))
const ConflictsTab = lazy(() => import('./ConflictsTab'))

export const sync: FeatureManifest = { id: 'sync', title: 'Sync', icon: FolderSync, Page: SyncPage, Background: SyncBackground, Settings: SyncSettings, settingsOrder: 60, tabKinds: { 'sync-conflicts': ConflictsTab } }
