import { FolderKanban } from 'lucide-react'
import type { FeatureManifest } from '../features'
import ProjectsPage from './ProjectsPage'

/** Projects with their synced folder, notes, task board and milestones (src-tauri/src/projects.rs). */
export const projects: FeatureManifest = { id: 'projects', title: 'Projects', icon: FolderKanban, Page: ProjectsPage }
