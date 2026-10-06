import { lazy } from 'react'
import { FolderKanban } from 'lucide-react'
import type { FeatureManifest } from '../features'
const ProjectsPage = lazy(() => import('./ProjectsPage'))

/** Projects with their synced folder, notes, task board and milestones (src-tauri/src/projects.rs). */
export const projects: FeatureManifest = { id: 'projects', title: 'Projects', icon: FolderKanban, Page: ProjectsPage }
