import { NotebookPen } from 'lucide-react'
import type { FeatureManifest } from '../features'
import NotesPage from './NotesPage'
import { NotesBackground, overdueStore } from './state'

/** Notes and checklists, kept on every paired computer (src-tauri/src/bridgelink/notes.rs). */
export const notes: FeatureManifest = { id: 'notes', title: 'Notes', icon: NotebookPen, Page: NotesPage, Background: NotesBackground, badge: overdueStore }
