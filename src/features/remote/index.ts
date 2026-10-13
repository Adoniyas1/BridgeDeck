import { lazy } from 'react'
import { MonitorUp } from 'lucide-react'
import type { FeatureManifest } from '../features'
import { RemoteBackground } from './state'
const RemoteSessionTab = lazy(() => import('./RemoteSessionTab'))

// No page of its own: remote control is part of Computers (RemoteHostCard), sessions open as tabs.
export const remote: FeatureManifest = { id: 'remote', title: 'Remote', icon: MonitorUp, Background: RemoteBackground, tabKinds: { 'remote-session': RemoteSessionTab } }
