import { lazy } from 'react'
import { GraduationCap } from 'lucide-react'
import type { FeatureManifest } from '../features'
import { StudySettings } from './StudySettings'
import { StudyBackground as Reminders } from './AssignmentCards'
import { LecturePill } from './LecturePill'
const BookTab = lazy(() => import('./BookTab'))
const LectureTab = lazy(() => import('./LectureTab'))
const StudyPage = lazy(() => import('./StudyPage'))

/** Reminders, and the lecture being recorded or transcribed (shown over every tab). */
function StudyBackground() {
  return <><Reminders /><LecturePill /></>
}

/** Courses with their textbooks, notes, chapter checklists and exams (src-tauri/src/study.rs). */
export const study: FeatureManifest = { id: 'study', title: 'Study', icon: GraduationCap, Page: StudyPage, tabKinds: { 'study-book': BookTab, 'study-lecture': LectureTab }, Background: StudyBackground, Settings: StudySettings, settingsOrder: 45 }
