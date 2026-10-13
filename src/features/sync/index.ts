import { lazy } from 'react'
import { FolderSync } from 'lucide-react'
import type { FeatureManifest } from '../features'
import SyncSettings from './SyncSettings'
import { SyncBackground } from './state'
const ConflictsTab = lazy(() => import('./ConflictsTab'))

// No page of its own: synced folders are part of the Files page (files/FilesAndSync.tsx).
export const sync: FeatureManifest = { id: 'sync', title: 'Sync', icon: FolderSync, Background: SyncBackground, Settings: SyncSettings, settingsOrder: 60, tabKinds: { 'sync-conflicts': ConflictsTab } }
