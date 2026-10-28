import { lazy } from 'react'
import { FolderKanban } from 'lucide-react'
import type { FeatureManifest } from '../features'
const ProjectsPage = lazy(() => import('./ProjectsPage'))
const KiCadTab = lazy(() => import('./KiCadTab').then(m => ({ default: m.KiCadTab })))

/** Projects with their synced folder, notes, task board and milestones (src-tauri/src/projects.rs),
 *  and a viewer for the KiCad files in it. */
export const projects: FeatureManifest = { id: 'projects', title: 'Projects', icon: FolderKanban, Page: ProjectsPage, tabKinds: { kicad: KiCadTab } }
