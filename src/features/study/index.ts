import { lazy } from 'react'
import { GraduationCap } from 'lucide-react'
import type { FeatureManifest } from '../features'
import { StudySettings } from './StudySettings'
import { StudyBackground } from './AssignmentCards'
const BookTab = lazy(() => import('./BookTab'))
const StudyPage = lazy(() => import('./StudyPage'))

/** Courses with their textbooks, notes, chapter checklists and exams (src-tauri/src/study.rs). */
export const study: FeatureManifest = { id: 'study', title: 'Study', icon: GraduationCap, Page: StudyPage, tabKinds: { 'study-book': BookTab }, Background: StudyBackground, Settings: StudySettings, settingsOrder: 45 }
