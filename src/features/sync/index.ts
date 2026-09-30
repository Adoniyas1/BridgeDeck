import { FolderSync } from 'lucide-react'
import type { FeatureManifest } from '../features'
import SyncPage from './SyncPage'
import SyncSettings from './SyncSettings'
import ConflictsTab from './ConflictsTab'
import { SyncBackground } from './state'

export const sync: FeatureManifest = { id: 'sync', title: 'Sync', icon: FolderSync, Page: SyncPage, Background: SyncBackground, Settings: SyncSettings, settingsOrder: 60, tabKinds: { 'sync-conflicts': ConflictsTab } }
