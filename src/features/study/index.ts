import { GraduationCap } from 'lucide-react'
import type { FeatureManifest } from '../features'
import BookTab from './BookTab'
import StudyPage from './StudyPage'

/** Courses with their textbooks, notes, chapter checklists and exams (src-tauri/src/study.rs). */
export const study: FeatureManifest = { id: 'study', title: 'Study', icon: GraduationCap, Page: StudyPage, tabKinds: { 'study-book': BookTab } }
